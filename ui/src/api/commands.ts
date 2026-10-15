/**
 * The shell command palette: the user's labelled commands (backend routers/commands.py), one list
 * for every engine and both views. A scope says which containers a command is offered for.
 */
import { api } from "./ddclient";

export type ScopeKind = "all" | "image" | "compose";

export interface PaletteCommand {
  id: string;
  label: string;
  command: string;
  /** True: type it and press Enter. False: only type it. */
  run: boolean;
  scope: { kind: ScopeKind; image: string; project: string; service: string };
}

/** What a command's scope is matched against. */
export interface ShellTarget {
  image: string;
  project: string | null;
  service: string | null;
}

export const loadCommands = () => api.get<PaletteCommand[]>("/commands");
export const saveCommands = (list: PaletteCommand[]) => api.put<PaletteCommand[]>("/commands", list);

export function newCommand(command = ""): PaletteCommand {
  return { id: "", label: "", command, run: false, scope: { kind: "all", image: "", project: "", service: "" } };
}

/** Glob (* and ?) to a case-insensitive whole-string match; an empty pattern matches anything. */
export function globMatch(pattern: string, value: string | null): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (value == null) return false;
  const re = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i").test(value);
}

/** Image names are matched with and without the registry, and without a tag when the pattern has none. */
function imageMatch(pattern: string, image: string): boolean {
  const short = image.replace(/^docker\.io\/(library\/)?/, "");
  const names = [image, short];
  if (!/:[^/]*$/.test(pattern.trim())) names.push(...names.map((n) => n.replace(/(@sha256)?:[^/]*$/, "")));
  return names.some((n) => globMatch(pattern, n));
}

export function commandApplies(c: PaletteCommand, t: ShellTarget): boolean {
  switch (c.scope.kind) {
    case "image":
      return imageMatch(c.scope.image, t.image);
    case "compose":
      return t.project != null && globMatch(c.scope.project, t.project) && globMatch(c.scope.service, t.service);
    default:
      return true;
  }
}

export function scopeText(c: PaletteCommand): string {
  const s = c.scope;
  if (s.kind === "image") return `Image ${s.image || "*"}`;
  if (s.kind === "compose") return `Compose ${s.project || "*"}${s.service ? ` / ${s.service}` : ""}`;
  return "Everywhere";
}
