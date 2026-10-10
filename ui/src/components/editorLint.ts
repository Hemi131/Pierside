/**
 * Error checking for the file editor: YAML syntax (the `yaml` package's parser) and, for Compose
 * files, the official Compose JSON schema (bundled in compose-schema/, never fetched). Loaded on
 * demand by CodeEditor's linter the first time a YAML file is checked, so neither the parser nor
 * the schema weighs on the editor chunk.
 */
import type { Diagnostic } from "@codemirror/lint";
import { isMap, isPair, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { Document, Node as YamlNode, Pair } from "yaml";
import type { OutputUnit, Validator } from "@cfworker/json-schema";

/** Compose files by name: compose.yaml, docker-compose.yml, compose.override.yaml, docker-compose.prod.yml, ... */
export const isComposeFile = (path: string) => /^(docker-)?compose(\.[^/]+)?\.ya?ml$/i.test(path.split("/").pop() ?? "");

/**
 * Checking runs on the page's thread after a pause in typing; the YAML parser needs about 1 ms per
 * KB, so bigger files aren't checked (JSON is: the browser's own parser is fast).
 */
export const YAML_LIMIT = 200 * 1024;
/** Above this size only the syntax is checked. */
const SCHEMA_LIMIT = 100 * 1024;

interface Compose {
  validator: Validator;
  /** Every property name the schema declares somewhere. */
  known: Set<string>;
  /** Property name → its description, for values that must match a pattern. */
  patterns: Map<string, string>;
}

let compose: Promise<Compose> | null = null;
const loadCompose = () =>
  (compose ??= Promise.all([import("@cfworker/json-schema"), import("./compose-schema/compose-spec.json")]).then(([{ Validator }, mod]) => {
    const schema = ((mod as { default?: object }).default ?? mod) as object;
    const known = new Set<string>();
    const patterns = new Map<string, string>();
    const walk = (s: unknown) => {
      if (!s || typeof s !== "object") return;
      const props = (s as { properties?: Record<string, { pattern?: string; description?: string }> }).properties;
      if (props && typeof props === "object")
        for (const [name, sub] of Object.entries(props)) {
          known.add(name);
          if (sub?.pattern && !patterns.has(name)) patterns.set(name, sub.description ?? `Expected a value matching ${sub.pattern}`);
        }
      for (const v of Object.values(s)) walk(v);
    };
    walk(schema);
    return { validator: new Validator(schema, "2020-12", false), known, patterns };
  }));

export async function lintYaml(text: string, path: string): Promise<Diagnostic[]> {
  if (text.length > YAML_LIMIT) return [];
  const docs = parseAllDocuments(text, { prettyErrors: false, merge: true });
  // A stream with only a parse error at the top level comes back as an object with `errors`.
  const list: Document.Parsed[] = Array.isArray(docs) ? docs : [];
  const out: Diagnostic[] = [];
  const clamp = (n: number) => Math.max(0, Math.min(text.length, n));
  const add = (from: number, to: number, severity: Diagnostic["severity"], message: string, source = "YAML") => {
    from = clamp(from);
    to = clamp(Math.max(from, to));
    // An error at the very end (e.g. an unclosed bracket) still needs a character to underline.
    if (to === from && from > 0 && from === text.length) from--;
    out.push({ from, to, severity, message, source });
  };
  if (!Array.isArray(docs)) for (const e of (docs as { errors: { pos: [number, number]; message: string }[] }).errors) add(e.pos[0], e.pos[1], "error", e.message);
  for (const d of list) {
    for (const e of d.errors) add(e.pos[0], e.pos[1], "error", e.message);
    for (const w of d.warnings) add(w.pos[0], w.pos[1], "warning", w.message);
  }
  if (out.some((d) => d.severity === "error") || !isComposeFile(path) || text.length > SCHEMA_LIMIT || !list.length) return out;

  const doc = list[0];
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 1000 });
  } catch {
    return out;
  }
  if (data === null || data === undefined) return out; // an empty file
  const c = await loadCompose();
  for (const p of schemaProblems(c.validator.validate(data).errors, c)) {
    const [from, to] = locate(doc, text, p.path, p.key);
    add(from, to, "warning", p.message, "Compose schema");
  }
  return out;
}

interface Problem {
  path: string[];
  /** The message is about the key at the end of `path` (an unknown property), not its value. */
  key: boolean;
  message: string;
}

/** A JSON pointer ("#/services/web/image") as its parts. */
const pointer = (loc: string) => {
  const rest = loc.replace(/^#\/?/, "");
  return (rest ? rest.split("/") : []).map((s) => {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep it as it is */
    }
    return s.replace(/~1/g, "/").replace(/~0/g, "~");
  });
};

/** Keywords that only say "something below failed": the useful message is in a deeper error. */
const WRAPPERS = new Set(["properties", "patternProperties", "$ref", "allOf", "anyOf", "oneOf", "items", "prefixItems", "additionalItems", "contains", "if", "then", "else", "not", "dependentSchemas", "propertyNames", "false"]);

/**
 * The validator reports every failing branch of every subschema; keep what a person can act on:
 * leaf errors (wrong type, value not allowed, missing property) and properties the schema doesn't
 * know. An "unknown property" is only real when nothing inside it failed (otherwise it's just a
 * known property whose value has a problem); and when anything else in the same object failed,
 * the schema's "unevaluated properties" check flags every property of that object, so then only
 * names the schema declares nowhere count. A wrong type at a place where some branch of the schema
 * accepted the type and found a deeper problem is the other branch talking, so it goes too.
 */
function schemaProblems(errors: OutputUnit[], c: Compose): Problem[] {
  // Where something real failed: leaf errors, and objects with a property the schema rejects.
  const failedAt = errors.filter((e) => !WRAPPERS.has(e.keyword)).map((e) => e.instanceLocation);
  const below = (loc: string) => failedAt.some((l) => l === loc || l.startsWith(loc + "/"));
  const deeper = (loc: string) => failedAt.some((l) => l.startsWith(loc + "/"));
  const problems = new Map<string, Problem>();
  const types = new Map<string, Set<string>>();

  for (const e of errors) {
    if (e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties") {
      const m = /^Property "(.*)" does not match/.exec(e.error);
      if (!m) continue;
      const loc = `${e.instanceLocation}/${m[1].replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (below(loc) || (deeper(e.instanceLocation) && c.known.has(m[1]))) continue;
      problems.set(`${loc}|unknown`, { path: pointer(loc), key: true, message: `Property "${m[1]}" is not allowed here.` });
    } else if (e.keyword === "pattern") {
      if (deeper(e.instanceLocation)) continue;
      const path = pointer(e.instanceLocation);
      const hint = c.patterns.get(path[path.length - 1]);
      problems.set(`${e.instanceLocation}|pattern`, { path, key: false, message: hint ? `Invalid value. ${hint}` : "Invalid value: it doesn't match the expected format." });
    } else if (e.keyword === "type") {
      if (deeper(e.instanceLocation)) continue;
      const m = /Instance type "(.*)" is invalid\. Expected (.*)\.$/.exec(e.error);
      const set = types.get(e.instanceLocation) ?? new Set<string>();
      for (const t of (m?.[2] ?? "").split(/,\s*/)) if (t) set.add(t.replace(/"/g, ""));
      types.set(e.instanceLocation, set);
      problems.set(`${e.instanceLocation}|type`, { path: pointer(e.instanceLocation), key: false, message: m ? `Wrong type: ${m[1]}.` : e.error });
    } else if (!WRAPPERS.has(e.keyword)) {
      if (e.keyword !== "required" && deeper(e.instanceLocation)) continue;
      const req = /required property "(.*)"/.exec(e.error);
      const message = req ? `Missing required property "${req[1]}".` : e.error.replace(/^Instance /, "Value ");
      problems.set(`${e.instanceLocation}|${message}`, { path: pointer(e.instanceLocation), key: e.keyword === "required", message });
    }
  }
  // One message per place for a wrong type, listing every type some branch would have taken.
  for (const [loc, set] of types) {
    const p = problems.get(`${loc}|type`);
    if (p && set.size) p.message = `${p.message.replace(/\.$/, "")}, expected ${[...set].join(" or ")}.`;
  }
  return [...problems.values()];
}

/**
 * Where a schema problem is in the text: the value at `path` (or its key, for an unknown or
 * required property, or when the value is empty). Falls back to the deepest part of the path that
 * exists (e.g. keys that come in through a `<<` merge).
 */
function locate(doc: Document.Parsed, text: string, path: string[], key: boolean): [number, number] {
  let node: unknown = doc.contents;
  let pair: Pair | null = null;
  let best: [number, number] = [0, 0];
  const rangeOf = (n: unknown): [number, number] | null => {
    const r = (n as YamlNode | null)?.range;
    return r ? [r[0], r[1]] : null;
  };
  const first = rangeOf(node);
  if (first) best = firstLine(text, first);
  for (const seg of path) {
    if (isMap(node)) {
      const found = node.items.find((p) => isPair(p) && String(isScalar(p.key) ? p.key.value : p.key) === seg) as Pair | undefined;
      if (!found) break;
      pair = found;
      node = found.value;
      const k = rangeOf(found.key);
      if (k) best = k;
    } else if (isSeq(node)) {
      const item = node.items[Number(seg)];
      if (item === undefined) break;
      pair = null;
      node = item;
    } else break;
    const v = rangeOf(node);
    if (v) best = v;
  }
  if (key && pair) return rangeOf(pair.key) ?? best;
  // A block map or list as the value: underline its key (or first line) rather than the whole block.
  const multiline = text.slice(best[0], best[1]).includes("\n");
  return (isMap(node) || isSeq(node)) && multiline ? (pair && rangeOf(pair.key)) || firstLine(text, best) : best;
}

/** A range cut to its first line. */
function firstLine(text: string, [from, to]: [number, number]): [number, number] {
  const nl = text.indexOf("\n", from);
  return [from, nl >= 0 && nl < to ? nl : to];
}
