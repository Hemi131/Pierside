// pierside-mcp-setup registers Pierside's MCP server with AI coding assistants (Claude Code, Devin
// CLI) on the user's computer, so the AI access page can do it with one click. Rancher Desktop
// ships it with the extension (metadata.json "host" binaries) and runs it for the UI
// (ddClient.extension.host.cli.exec). It runs the assistant's own CLI, which writes its own
// configuration; Pierside never edits those files itself.
//
//	pierside-mcp-setup find                                  which assistants are installed
//	pierside-mcp-setup add <claude|devin> <name> [--dir <folder>] -- docker …
//	                                                         register (replacing an entry of that name)
//	pierside-mcp-setup remove <claude|devin> <name> [--dir <folder>]
//	                                                         unregister (for the user, or for that folder)
//
// For the user ("all projects" scope), or with --dir only for that project folder: the assistant's
// command then runs in the folder with its default scope, which keeps the entry in the user's own
// configuration for that folder rather than in a file inside it. It prints one JSON object and exits
// 0, so the caller reads the outcome from "ok" rather than from an exception.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type result struct {
	OK      bool              `json:"ok"`
	Message string            `json:"message,omitempty"`
	Output  string            `json:"output,omitempty"`
	Path    string            `json:"path,omitempty"`
	Found   map[string]string `json:"found,omitempty"`
}

var clients = map[string]struct {
	label string
	scope []string // the "for the user" flag of `mcp add` / `mcp remove`
}{
	"claude": {"Claude Code", []string{"--scope", "user"}},
	"devin":  {"Devin CLI", []string{"-s", "user"}},
}

var (
	validName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
	// What the registered command may contain: `docker exec -i [-e PIERSIDE_MCP_TOKEN=…] <container>
	// python -m app.mcp_stdio [--profile <id>]`. Plain words only: no quotes, spaces or shell
	// characters, so nothing can be smuggled through a .cmd wrapper's command line.
	validArg = regexp.MustCompile(`^[A-Za-z0-9_.=:/-]{1,200}$`)
)

func main() {
	out := run(os.Args[1:])
	data, _ := json.Marshal(out)
	fmt.Println(string(data))
}

func run(args []string) result {
	if len(args) == 0 {
		return result{Message: "usage: find | add <client> <name> -- <command…> | remove <client> <name>"}
	}
	switch args[0] {
	case "find":
		found := map[string]string{}
		for name := range clients {
			if p := locate(name); p != "" {
				found[name] = p
			}
		}
		return result{OK: true, Found: found}
	case "add":
		usage := result{Message: "usage: add <client> <name> [--dir <folder>] -- docker <args…>"}
		if len(args) < 4 {
			return usage
		}
		rest, dir := args[3:], ""
		if rest[0] == "--dir" {
			if len(rest) < 3 {
				return usage
			}
			dir, rest = rest[1], rest[2:]
			if st, err := os.Stat(dir); err != nil || !st.IsDir() || !filepath.IsAbs(dir) {
				return result{Message: "the folder doesn't exist: " + dir}
			}
		}
		if len(rest) < 3 || rest[0] != "--" || rest[1] != "docker" {
			return usage
		}
		for _, a := range rest[1:] {
			if !validArg.MatchString(a) {
				return result{Message: fmt.Sprintf("refusing an unexpected argument: %q", a)}
			}
		}
		if !pierside(rest[1:]) {
			return result{Message: "refusing a command that isn't Pierside's MCP bridge (docker exec -i … python -m app.mcp_stdio)"}
		}
		return add(args[1], args[2], dir, rest[1:])
	case "remove":
		dir := ""
		switch {
		case len(args) == 5 && args[3] == "--dir":
			dir = args[4]
			if st, err := os.Stat(dir); err != nil || !st.IsDir() || !filepath.IsAbs(dir) {
				return result{OK: true, Message: "the folder no longer exists: " + dir}
			}
		case len(args) != 3:
			return result{Message: "usage: remove <client> <name> [--dir <folder>]"}
		}
		return remove(args[1], args[2], dir)
	}
	return result{Message: "unknown command " + args[0]}
}

// pierside checks the exact shape of the command to register: `docker exec -i [-e
// PIERSIDE_MCP_TOKEN=…] <container> python -m app.mcp_stdio [--profile <id>]`. Anything else, even
// made of plain words, could make an assistant start some other docker command on every launch.
func pierside(cmd []string) bool {
	if len(cmd) < 3 || cmd[0] != "docker" || cmd[1] != "exec" || cmd[2] != "-i" {
		return false
	}
	rest := cmd[3:]
	if len(rest) >= 2 && rest[0] == "-e" {
		if !strings.HasPrefix(rest[1], "PIERSIDE_MCP_TOKEN=") {
			return false
		}
		rest = rest[2:]
	}
	if len(rest) < 4 || strings.HasPrefix(rest[0], "-") || rest[1] != "python" || rest[2] != "-m" || rest[3] != "app.mcp_stdio" {
		return false
	}
	rest = rest[4:]
	return len(rest) == 0 || (len(rest) == 2 && rest[0] == "--profile" && !strings.HasPrefix(rest[1], "-"))
}

func add(client, name, dir string, command []string) result {
	c, ok := clients[client]
	if !ok || !validName.MatchString(name) {
		return result{Message: "unknown assistant or bad name"}
	}
	path := locate(client)
	if path == "" {
		return result{Message: c.label + " isn't installed for this user (" + client + " wasn't found)"}
	}
	scope := c.scope
	if dir != "" {
		scope = nil // the assistant's default: this folder only
	}
	// Replace an older entry of the same name (an earlier connection, or one with another token).
	_, _ = exe(dir, path, append([]string{"mcp", "remove", name}, scope...)...)
	output, err := exe(dir, path, append(append(append([]string{"mcp", "add"}, scope...), name, "--"), command...)...)
	if err != nil {
		return result{Path: path, Output: output, Message: c.label + " couldn't add the server: " + err.Error()}
	}
	return result{OK: true, Path: path, Output: output}
}

func remove(client, name, dir string) result {
	c, ok := clients[client]
	if !ok || !validName.MatchString(name) {
		return result{Message: "unknown assistant or bad name"}
	}
	path := locate(client)
	if path == "" {
		return result{OK: true, Message: c.label + " isn't installed"}
	}
	if dir != "" {
		// Registered for that folder only: removed there, with the assistant's default scope (as added).
		output, err := exe(dir, path, "mcp", "remove", name)
		if err != nil {
			return result{Path: path, Output: output, Message: err.Error()}
		}
		return result{OK: true, Path: path, Output: output}
	}
	output, err := exe("", path, append([]string{"mcp", "remove", name}, c.scope...)...)
	if err != nil {
		// Older versions may not take a scope on remove.
		if output2, err2 := exe("", path, "mcp", "remove", name); err2 == nil {
			return result{OK: true, Path: path, Output: output2}
		}
		return result{Path: path, Output: output, Message: err.Error()}
	}
	return result{OK: true, Path: path, Output: output}
}

// locate finds an assistant's CLI: on PATH, or where its installers usually put it (Rancher Desktop
// may have been started with a shorter PATH than the user's terminal).
func locate(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	home, _ := os.UserHomeDir()
	var candidates []string
	if runtime.GOOS == "windows" {
		appdata := os.Getenv("APPDATA")
		local := os.Getenv("LOCALAPPDATA")
		candidates = []string{
			filepath.Join(home, ".local", "bin", name+".exe"),
			filepath.Join(appdata, "npm", name+".cmd"),
			filepath.Join(local, "Programs", name, name+".exe"),
			filepath.Join(home, "."+name, "bin", name+".exe"),
		}
	} else {
		candidates = []string{
			filepath.Join(home, ".local", "bin", name),
			filepath.Join(home, "."+name, "bin", name),
			"/opt/homebrew/bin/" + name,
			"/usr/local/bin/" + name,
		}
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

// exe runs the assistant's CLI, in `dir` when given.
func exe(dir, path string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Dir = dir
	// On Windows a .cmd wrapper's child (node) can keep the output pipes open after the wrapper is
	// killed: stop waiting for them shortly after.
	cmd.WaitDelay = 5 * time.Second
	hide(cmd)
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(string(out))
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return text, errors.New("it didn't finish within 60 seconds")
	}
	if err != nil && text != "" {
		return text, errors.New(lastLine(text))
	}
	return text, err
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
