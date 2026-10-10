/**
 * Registers Pierside's MCP server with AI assistants on the user's computer (Claude Code, Devin CLI),
 * through the small program Pierside ships as a Rancher Desktop host binary (host/mcpsetup). It runs
 * the assistant's own CLI (`claude mcp add …`), for all the user's projects or for one folder. Only inside
 * Rancher Desktop: the standalone window and the dev server can't run programs on the computer.
 */
import { dd, inExtension } from "./ddclient";

export type Assistant = "claude" | "devin";
export const ASSISTANT_LABEL: Record<Assistant, string> = { claude: "Claude Code", devin: "Devin CLI" };

interface SetupResult {
  ok: boolean;
  message?: string;
  output?: string;
  path?: string;
  found?: Partial<Record<Assistant, string>>;
}

const binary = () => (dd?.host.platform === "win32" ? "pierside-mcp-setup.exe" : "pierside-mcp-setup");

export const canSetUp = inExtension;

async function setup(args: string[]): Promise<SetupResult> {
  const host = dd?.extension.host;
  if (!host) throw new Error("Only inside Rancher Desktop");
  try {
    const r = await host.cli.exec(binary(), args);
    return JSON.parse(r.stdout) as SetupResult;
  } catch (e) {
    // The program always exits 0; an exception means it couldn't be started at all.
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr || err.message || "Pierside's setup helper couldn't be started");
  }
}

let found: Promise<Partial<Record<Assistant, string>>> | null = null;

/** Which assistants are installed (where their CLI is); asked once per window. */
export function installedAssistants(): Promise<Partial<Record<Assistant, string>>> {
  found ??= setup(["find"]).then((r) => r.found ?? {});
  return found;
}

/**
 * Register (or replace) the server `name` running `docker <args>`: for all the user's projects, or
 * with `folder` only for that project folder. Resolves with the CLI's own message.
 */
export async function addToAssistant(assistant: Assistant, name: string, args: string[], folder?: string): Promise<string> {
  const r = await setup(["add", assistant, name, ...(folder ? ["--dir", folder] : []), "--", "docker", ...args]);
  if (!r.ok) throw new Error(r.message || `${ASSISTANT_LABEL[assistant]} couldn't add the server`);
  return r.output ?? "";
}

/** Unregister `name` from every installed assistant that has it; resolves with the ones it was removed from. */
export async function removeFromAssistants(name: string): Promise<Assistant[]> {
  const installed = await installedAssistants();
  const removed: Assistant[] = [];
  for (const a of Object.keys(installed) as Assistant[]) {
    const r = await setup(["remove", a, name]).catch(() => null);
    if (r?.ok && /removed/i.test(r.output ?? "")) removed.push(a);
  }
  return removed;
}
