/**
 * The languages the file editor can highlight, and which one a file name gets by default.
 * Kept apart from CodeEditor.tsx (which holds the parsers) so the file browser can show and offer
 * them without loading the editor bundle.
 */
export const LANGUAGES = [
  { id: "plain", label: "Plain text" },
  { id: "yaml", label: "YAML" },
  { id: "json", label: "JSON" },
  { id: "dockerfile", label: "Dockerfile" },
  { id: "shell", label: "Shell" },
  { id: "nginx", label: "nginx" },
  { id: "properties", label: "INI / .env" },
  { id: "toml", label: "TOML" },
  { id: "xml", label: "XML" },
  { id: "html", label: "HTML" },
  { id: "css", label: "CSS" },
  { id: "markdown", label: "Markdown" },
  { id: "sql", label: "SQL" },
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "go", label: "Go" },
  { id: "rust", label: "Rust" },
  { id: "ruby", label: "Ruby" },
  { id: "java", label: "Java" },
  { id: "c", label: "C" },
  { id: "cpp", label: "C++" },
  { id: "lua", label: "Lua" },
  { id: "perl", label: "Perl" },
  { id: "powershell", label: "PowerShell" },
  { id: "diff", label: "Diff" },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]["id"];

export const languageLabel = (id: LanguageId) => LANGUAGES.find((l) => l.id === id)?.label ?? id;

const BY_EXTENSION: Record<string, LanguageId> = {
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "toml",
  ini: "properties",
  cfg: "properties",
  cnf: "properties",
  conf: "properties",
  properties: "properties",
  env: "properties",
  go: "go",
  rs: "rust",
  rb: "ruby",
  lua: "lua",
  pl: "perl",
  ps1: "powershell",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  java: "java",
  diff: "diff",
  patch: "diff",
};

/** The language a file gets from its name or extension ("plain" when unknown). */
export function detectLanguage(path: string): LanguageId {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if ((name.includes("nginx") || path.toLowerCase().includes("/nginx/")) && (name.endsWith(".conf") || !name.includes("."))) return "nginx";
  if (name.startsWith(".env")) return "properties";
  if ([".bashrc", ".profile", ".bash_profile", ".zshrc"].includes(name)) return "shell";
  return BY_EXTENSION[name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : ""] ?? "plain";
}
