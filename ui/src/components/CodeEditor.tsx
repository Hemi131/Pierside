/**
 * Code editor / viewer (CodeMirror 6) for the file browser: syntax highlighting per language, line
 * numbers, folding, search and replace (Ctrl+F), multiple cursors, bracket matching, undo history.
 * One instance serves both the read-only preview and editing (`readOnly` toggles), so the scroll
 * position stays put when the user clicks Edit. Text always uses \n inside; the caller decides the
 * line ending written to disk.
 * Also: error checking for JSON and YAML (Compose files against the Compose schema, see
 * editorLint.ts), a diff against the loaded text before saving (`original`), VS Code's editing
 * shortcuts, bracket pair colours and indentation guides.
 */
import { useEffect, useRef } from "react";
import { Box, useTheme } from "@mui/material";
import { basicSetup } from "codemirror";
import { Compartment, EditorSelection, EditorState, Extension, StateCommand } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Diagnostic, linter, lintGutter } from "@codemirror/lint";
import { unifiedMergeView } from "@codemirror/merge";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { defaultHighlightStyle, ensureSyntaxTree, indentUnit, StreamLanguage, StreamParser, syntaxHighlighting } from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { markdown } from "@codemirror/lang-markdown";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { go } from "@codemirror/legacy-modes/mode/go";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { c, cpp, java } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { inExtension } from "../api/ddclient";
import { MONO } from "../theme";
import type { LanguageId } from "./codeLanguages";
import { bracketColors } from "./bracketColors";

const legacy = (parser: unknown) => () => StreamLanguage.define(parser as StreamParser<unknown>);

/** The parser for each language id (see codeLanguages.ts for names and file-name detection). */
const PARSERS: Record<LanguageId, () => Extension> = {
  plain: () => [],
  yaml: yaml,
  json: json,
  dockerfile: legacy(dockerFile),
  shell: legacy(shell),
  nginx: legacy(nginx),
  properties: legacy(properties),
  toml: legacy(toml),
  xml: xml,
  html: () => html(),
  css: css,
  markdown: markdown,
  sql: () => sql(),
  python: python,
  javascript: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true, jsx: true }),
  go: legacy(go),
  rust: legacy(rust),
  ruby: legacy(ruby),
  java: legacy(java),
  c: legacy(c),
  cpp: legacy(cpp),
  lua: legacy(lua),
  perl: legacy(perl),
  powershell: legacy(powerShell),
  diff: legacy(diff),
};

// A viewer has no text cursor (the selection still shows).
const noCursor = EditorView.theme({ ".cm-cursorLayer": { display: "none" } });
const locked = (readOnly: boolean): Extension => [EditorState.readOnly.of(readOnly), readOnly ? noCursor : []];

/**
 * JSON syntax errors, from the browser's parser. Its message doesn't always say where (e.g.
 * "Unexpected token ','"), so then the first error in the editor's own parse of the text marks it.
 */
function jsonCheck(view: EditorView): Diagnostic[] {
  const { state } = view;
  const text = state.doc.toString();
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    const raw = (e as Error).message;
    let pos = Number(/at position (\d+)/.exec(raw)?.[1] ?? -1);
    if (pos < 0)
      ensureSyntaxTree(state, state.doc.length, 300)?.iterate({
        enter: (n) => {
          if (pos >= 0) return false;
          if (n.type.isError) pos = n.from;
        },
      });
    pos = Math.max(0, Math.min(pos, text.length));
    const message = raw.replace(/^(Unexpected token .+?), .* is not valid JSON$/s, "$1").replace(/ in JSON at position \d+.*$/s, "") || "Invalid JSON";
    return [{ from: pos, to: Math.min(text.length, pos + 1), severity: "error", message, source: "JSON" }];
  }
}

/**
 * Error checking by language: JSON with the browser's parser, YAML (and Compose files against the
 * Compose schema) with code loaded on first use. Runs after a pause in typing.
 */
function checks(language: LanguageId, path: string, enabled: boolean): Extension {
  if (!enabled) return [];
  if (language === "json") return [linter(jsonCheck, { delay: 500 }), lintGutter()];
  if (language === "yaml")
    return [linter((view) => import("./editorLint").then((m) => m.lintYaml(view.state.doc.toString(), path)), { delay: 600 }), lintGutter()];
  return [];
}

/** The diff against the loaded text, shown inside the editor (deleted lines above the new ones). */
const review = (original: string | null | undefined): Extension =>
  original == null
    ? []
    : unifiedMergeView({ original, mergeControls: false, gutter: true, syntaxHighlightDeletions: true, collapseUnchanged: { margin: 3, minSize: 6 } });

/** VS Code's Ctrl+L: select the whole line; pressed again, the next line too. */
const selectLines: StateCommand = ({ state, dispatch }) => {
  const ranges = state.selection.ranges.map((r) =>
    EditorSelection.range(state.doc.lineAt(r.from).from, Math.min(state.doc.lineAt(r.to).to + 1, state.doc.length)),
  );
  dispatch(state.update({ selection: EditorSelection.create(ranges, state.selection.mainIndex), scrollIntoView: true, userEvent: "select" }));
  return true;
};

/** VS Code's Ctrl+Shift+Enter: a new line above the cursor's, indented like it. */
const insertLineAbove: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const indent = /^\s*/.exec(line.text)?.[0] ?? "";
    return { changes: { from: line.from, insert: indent + "\n" }, range: EditorSelection.cursor(line.from + indent.length) };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

export interface CodeEditorProps {
  /** Path of the file shown: a new path resets the editor. */
  path: string;
  /** Syntax highlighting (the caller detects it from the file name; the user may override it). */
  language: LanguageId;
  /** The text (with \n line endings). Changes from outside replace the content. */
  value: string;
  readOnly: boolean;
  wrap: boolean;
  /** Error checking (off for a file shown only in part). */
  check?: boolean;
  /** Review mode: the text as loaded, to show the changes against it (the editor is read-only meanwhile). */
  original?: string | null;
  onChange?: (value: string) => void;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
}

export function CodeEditor({ path, language, value, readOnly, wrap, check = true, original, onChange, onSave }: CodeEditorProps) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  const emitted = useRef<string | null>(null); // the text last given to onChange
  handlers.current = { onChange, onSave };
  const parts = useRef({
    wrap: new Compartment(),
    readOnly: new Compartment(),
    look: new Compartment(),
    language: new Compartment(),
    checks: new Compartment(),
    review: new Compartment(),
  });
  const locks = readOnly || original != null;

  const dark = theme.palette.mode === "dark";
  const look = (): Extension => [
    EditorView.theme(
      {
        "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent", color: theme.palette.text.primary },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": { fontFamily: MONO, lineHeight: "1.5" },
        ".cm-gutters": { backgroundColor: "transparent", color: theme.palette.text.disabled, border: "none" },
        ".cm-activeLine": { backgroundColor: theme.palette.action.hover },
        ".cm-activeLineGutter": { backgroundColor: theme.palette.action.hover, color: theme.palette.text.secondary },
        ".cm-cursor": { borderLeftColor: theme.palette.text.primary },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
          backgroundColor: dark ? "rgba(61,139,255,0.30)" : "rgba(10,99,237,0.18)",
        },
        ".cm-panels": { backgroundColor: theme.palette.background.default, color: theme.palette.text.primary, borderColor: theme.palette.divider },
        ".cm-panel input, .cm-panel button": { fontSize: "12px" },
        ".cm-searchMatch": { backgroundColor: dark ? "#6e5a00" : "#fff1a8" },
        ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: dark ? "#b36b00" : "#ffb340" },
        ".cm-tooltip": { backgroundColor: theme.palette.background.paper, borderColor: theme.palette.divider },
        ".cm-foldPlaceholder": { backgroundColor: theme.palette.action.selected, border: "none", color: theme.palette.text.secondary },
        // Bracket pairs by depth (VS Code's colours), and a closing bracket without a partner.
        ".cm-bracket-0": { color: dark ? "#ffd700" : "#0431fa" },
        ".cm-bracket-1": { color: dark ? "#da70d6" : "#319331" },
        ".cm-bracket-2": { color: dark ? "#179fff" : "#7b3814" },
        ".cm-bracket-unmatched": { color: dark ? "#ff6b6b" : "#e51400", textDecoration: "underline wavy" },
        ".cm-tooltip-lint": { fontSize: "12px" },
        ".cm-diagnosticSource": { opacity: 0.7 },
      },
      { dark },
    ),
    indentationMarkers({
      thickness: 1,
      colors: { light: theme.palette.divider, dark: theme.palette.divider, activeLight: theme.palette.text.disabled, activeDark: theme.palette.text.disabled },
    }),
    // Not a fallback: basicSetup already registers the (light) default style as one, which would win.
    syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle),
  ];

  // One editor per file.
  useEffect(() => {
    if (!host.current) return;
    const p = parts.current;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                handlers.current.onSave?.();
                return true;
              },
            },
            // Inside Rancher, Ctrl+V goes to the app's Edit menu and never reaches the page as a paste
            // event (as in the terminals), so paste explicitly there.
            ...(inExtension
              ? [
                  {
                    key: "Mod-v",
                    run: (view: EditorView) => {
                      if (view.state.readOnly || !navigator.clipboard?.readText) return false;
                      void navigator.clipboard.readText().then((text) => {
                        if (text) view.dispatch(view.state.replaceSelection(text.replace(/\r\n?/g, "\n")), { scrollIntoView: true, userEvent: "input.paste" });
                      });
                      return true;
                    },
                  },
                ]
              : []),
            // VS Code shortcuts that CodeMirror binds differently or not at all (the others it already
            // has: Ctrl+D, Alt+Up/Down, Shift+Alt+Up/Down, Ctrl+/, Ctrl+Shift+K, Ctrl+Enter).
            { key: "Mod-l", run: selectLines, preventDefault: true },
            { key: "Shift-Mod-Enter", run: insertLineAbove, preventDefault: true },
            indentWithTab,
            // Read-only: indenting does nothing, and Tab would move the focus out of the viewer (behind
            // the maximized panel), so swallow it.
            { key: "Tab", run: (view: EditorView) => view.state.readOnly, shift: (view: EditorView) => view.state.readOnly },
          ]),
          basicSetup,
          indentUnit.of("  "),
          p.language.of(PARSERS[language]()),
          p.checks.of(checks(language, path, check)),
          p.review.of(review(original)),
          bracketColors,
          p.look.of(look()),
          p.wrap.of(wrap ? EditorView.lineWrapping : []),
          // Read-only still takes focus (like a read-only file in VS Code), so search, selection and
          // copy work in the preview too; it just can't be changed.
          p.readOnly.of(locked(locks)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && handlers.current.onChange) {
              // Remember what was handed out, so that getting the same text back as `value` costs nothing.
              emitted.current = u.state.doc.toString();
              handlers.current.onChange(emitted.current);
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // Content replaced from outside (file reloaded, edit cancelled): only when it actually differs.
  useEffect(() => {
    const v = view.current;
    if (!v || value === emitted.current) return; // our own edit coming back: nothing to compare
    emitted.current = null;
    if (v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.language.reconfigure(PARSERS[language]()) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.checks.reconfigure(checks(language, path, check)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, check]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.review.reconfigure(review(original)) });
  }, [original]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: parts.current.readOnly.reconfigure(locked(locks)) });
    // Keep the view where the user was reading; in a review too, so Ctrl+S saves from there.
    if (!locks || original != null) v.contentDOM.focus({ preventScroll: true });
  }, [locks]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.look.reconfigure(look()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.palette.mode]);

  return <Box ref={host} sx={{ height: "100%", minHeight: 0, "& .cm-editor": { height: "100%" } }} />;
}
