package main

import "testing"

func TestPiersideShape(t *testing.T) {
	ok := [][]string{
		{"docker", "exec", "-i", "pierside-backend", "python", "-m", "app.mcp_stdio"},
		{"docker", "exec", "-i", "pierside-backend", "python", "-m", "app.mcp_stdio", "--profile", "ab12"},
		{"docker", "exec", "-i", "-e", "PIERSIDE_MCP_TOKEN=pmcp_x", "rd-extension-x", "python", "-m", "app.mcp_stdio"},
	}
	bad := [][]string{
		{"docker", "run", "-i", "alpine"},
		{"docker", "exec", "-i", "evil", "sh"},
		{"docker", "exec", "-i", "-e", "OTHER=1", "c", "python", "-m", "app.mcp_stdio"},
		{"docker", "exec", "-i", "--privileged", "c", "python", "-m", "app.mcp_stdio"},
		{"docker", "exec", "-i", "c", "python", "-m", "app.mcp_stdio", "--extra"},
		{"docker", "exec", "-i", "c", "python", "-m", "app.mcp_stdio", "--profile", "-x"},
	}
	for _, c := range ok {
		if !pierside(c) {
			t.Errorf("refused %v", c)
		}
	}
	for _, c := range bad {
		if pierside(c) {
			t.Errorf("accepted %v", c)
		}
	}
}
