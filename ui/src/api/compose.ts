/**
 * Running the real `docker compose` for a project Pierside remembers.
 *   - local engine: on the user's machine through Rancher's docker CLI (ddClient.docker.cli.exec),
 *     in the project folder, because that's where the compose files are;
 *   - SSH engine: on the server, through a backend job (routers/compose.py) the UI polls.
 * Every command runs detached (`up -d`): the output is shown while it runs, the logs afterwards.
 */
import { api, dd } from "./ddclient";

export interface UpOptions {
  build?: boolean;
  pull?: boolean;
  forceRecreate?: boolean;
  removeOrphans?: boolean;
  noDeps?: boolean;
  services?: string[];
  profiles?: string[];
  envFile?: string;
  extra?: string;
}
export interface DownOptions {
  volumes?: boolean;
  rmi?: boolean;
  removeOrphans?: boolean;
  extra?: string;
}
export interface ComposeOptions {
  up?: UpOptions;
  down?: DownOptions;
}

export interface ComposeProject {
  name: string;
  configFiles: string[];
  workingDir: string;
  options: ComposeOptions;
  lastSeen: number | null;
  containers: number;
  running: number;
  services: string[];
}
export interface ComposeProjects {
  engine: { id: string; type: "local" | "ssh" };
  projects: ComposeProject[];
}

export interface OutputLine {
  s: "stdout" | "stderr";
  m: string;
}

/** Split a free-text argument string, honouring "double" and 'single' quotes. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `file` relative to `dir` (Windows or POSIX style, following `dir`); absolute paths unchanged. */
function resolveIn(dir: string, file: string): string {
  if (!dir || /^([a-zA-Z]:[\\/]|[\\/])/.test(file)) return file;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + file.replace(/^\.[\\/]/, "");
}

/** Global args selecting the project: its files, name, profiles and env file. */
export function projectArgs(p: ComposeProject, o: { profiles?: string[]; envFile?: string } = {}): string[] {
  const args = ["--ansi", "never"];
  for (const f of p.configFiles) args.push("-f", f);
  args.push("-p", p.name);
  for (const prof of o.profiles ?? []) args.push("--profile", prof);
  if (o.envFile?.trim()) args.push("--env-file", resolveIn(p.workingDir, o.envFile.trim()));
  return args;
}

export function upArgs(p: ComposeProject, o: UpOptions): string[] {
  const args = [...projectArgs(p, o), "up", "-d"];
  if (o.build) args.push("--build");
  if (o.pull) args.push("--pull", "always");
  if (o.forceRecreate) args.push("--force-recreate");
  if (o.removeOrphans) args.push("--remove-orphans");
  if (o.noDeps && o.services?.length) args.push("--no-deps");
  args.push(...splitArgs(o.extra ?? ""));
  args.push(...(o.services ?? []));
  return args;
}

export function downArgs(p: ComposeProject, o: DownOptions, up: UpOptions = {}): string[] {
  const args = [...projectArgs(p, up), "down"];
  if (o.volumes) args.push("--volumes");
  if (o.rmi) args.push("--rmi", "local");
  if (o.removeOrphans) args.push("--remove-orphans");
  args.push(...splitArgs(o.extra ?? ""));
  return args;
}

/** For display and copying: `docker compose …` with arguments quoted where needed. */
export function commandLine(args: string[]): string {
  const q = (a: string) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);
  return ["docker", "compose", ...args].map(q).join(" ");
}

/** Exit code reported for a command stopped with cancel() (never mistaken for success). */
export const CANCELLED = -2;

export interface Run {
  done: Promise<number>; // exit code, or CANCELLED
  cancel: () => void;
}

/** Local engine: only inside Rancher Desktop (the standalone window can't run host commands). */
export const canRunLocal = () => !!dd;

function runLocal(args: string[], cwd: string, onLine: (l: OutputLine) => void): Run {
  let proc: { close: () => void } | null = null;
  let cancelled = false;
  const done = new Promise<number>((resolve) => {
    proc = dd!.docker.cli.exec("compose", args, {
      ...(cwd ? { cwd } : {}),
      stream: {
        splitOutputLines: true,
        onOutput: (d: { stdout?: string; stderr?: string }) => {
          if (d.stdout !== undefined) onLine({ s: "stdout", m: d.stdout });
          if (d.stderr !== undefined) onLine({ s: "stderr", m: d.stderr });
        },
        onError: (e: unknown) => {
          onLine({ s: "stderr", m: `Pierside: ${String((e as Error)?.message ?? e)}` });
          resolve(-1);
        },
        // A killed process may report no code (or 0): it did not succeed.
        onClose: (code: number) => resolve(cancelled ? CANCELLED : (code ?? -1)),
      },
    } as never) as unknown as { close: () => void };
  });
  return {
    done,
    cancel: () => {
      cancelled = true;
      proc?.close();
    },
  };
}

function runRemote(args: string[], cwd: string, onLine: (l: OutputLine) => void): Run {
  let jobId: string | null = null;
  let stopped = false;
  const done = (async () => {
    const { id } = await api.post<{ id: string }>("/compose/run", { args, cwd });
    jobId = id;
    let since = 0;
    for (;;) {
      const r = await api.get<{ state: string; code: number | null; lines: OutputLine[]; next: number }>(`/compose/run/${id}?since=${since}`);
      r.lines.forEach(onLine);
      since = r.next;
      if (r.state !== "running") return r.state === "cancelled" || stopped ? CANCELLED : (r.code ?? -1);
      await new Promise((res) => setTimeout(res, stopped ? 200 : 500));
    }
  })();
  return {
    done,
    cancel: () => {
      stopped = true;
      if (jobId) void api.del(`/compose/run/${jobId}`);
    },
  };
}

export function runCompose(engine: "local" | "ssh", args: string[], cwd: string, onLine: (l: OutputLine) => void): Run {
  if (engine === "ssh") return runRemote(args, cwd, onLine);
  if (!canRunLocal()) {
    return { done: Promise.reject(new Error("Running docker compose on the local engine works inside Rancher Desktop only")), cancel: () => undefined };
  }
  // No working directory locally: compose resolves paths relative to the compose file, and a folder
  // that no longer exists would make the process fail to start with a misleading "docker not found".
  void cwd;
  return runLocal(args, "", onLine);
}

/** Run to completion and collect stdout (e.g. `config --services`). Rejects with stderr on failure. */
export async function composeOutput(engine: "local" | "ssh", args: string[], cwd: string): Promise<string[]> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCompose(engine, args, cwd, (l) => (l.s === "stdout" ? out : err).push(l.m)).done;
  if (code !== 0) throw new Error(err.join("\n").trim() || `docker compose exited with code ${code}`);
  return out;
}

export function saveOptions(name: string, options: ComposeOptions) {
  return api.put(`/compose/projects/${encodeURIComponent(name)}`, { options });
}

/**
 * A plain-language explanation for common `docker compose` failures, from the command's output.
 * `where` names the machine ("this computer" / the SSH engine).
 */
export function explainComposeError(output: string[], p: ComposeProject | null, where: string): string | null {
  const text = output.join("\n");
  // Without the plugin, the docker CLI parses `compose --ansi never …` as its own flags ("unknown flag:
  // --ansi" + docker's top-level usage), or says 'compose' is not a docker command.
  if (/'compose' is not a docker command|docker: unknown command: docker compose|unknown flag: --ansi|Usage:\s+docker \[OPTIONS\] COMMAND/i.test(text)) {
    return `Docker Compose (v2) isn't installed on ${where}. Install the Compose plugin (e.g. the docker-compose-plugin package), then try again.`;
  }
  if (/(^|\s)docker: (command )?not found|docker: No such file or directory|'docker' is not recognized/i.test(text)) {
    return `The docker CLI isn't available on ${where}${where === "this computer" ? "" : " for non-interactive SSH sessions (check PATH, e.g. /usr/local/bin or /snap/bin)"}.`;
  }
  if (/permission denied.*docker(\.sock)?|Got permission denied while trying to connect/i.test(text)) {
    return `The user can't access the Docker socket on ${where}. Add it to the docker group (or use rootless Docker).`;
  }
  if (/Cannot connect to the Docker daemon|error during connect/i.test(text)) {
    return `The Docker engine on ${where} isn't reachable.`;
  }
  if (/can't cd to|cd: .*(No such file|can't)|chdir .*no such file|The directory name is invalid/i.test(text) && p) {
    return `The project folder ${p.workingDir} doesn't exist on ${where} any more.`;
  }
  if (/no such file or directory|cannot find the (file|path)|The system cannot find|no configuration file provided/i.test(text) && p) {
    return `The compose file isn't where it was (${p.configFiles.join(", ")}). If the project moved, use Open compose file to point Pierside at it, or Forget the project.`;
  }
  return null;
}

/** Local runs need paths of this computer: a project started from WSL/Linux records /home/... paths. */
export function localPathProblem(p: ComposeProject): string | null {
  const windows = (dd?.host as { platform?: string } | undefined)?.platform === "win32";
  if (windows && p.configFiles.some((f) => f.startsWith("/"))) {
    return `This project was started from WSL or Linux (${p.configFiles[0]}), so Windows can't open its files. Run docker compose from that environment, or open the compose file through its Windows path (e.g. \\\\wsl$\\Ubuntu\\home\\...).`;
  }
  return null;
}
