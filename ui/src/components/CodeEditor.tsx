/**
 * Code editor / viewer (CodeMirror 6) for the file browser: syntax highlighting per language, line
 * numbers, folding, search and replace (Ctrl+F), multiple cursors, bracket matching, undo history.
 * One instance serves both the read-only preview and editing (`readOnly` toggles), so the scroll
 * position stays put when the user clicks Edit. Text always uses \n inside; the caller decides the
 * line ending written to disk.
 */
import { useEffect, useRef } from "react";
import { Box, useTheme } from "@mui/material";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, indentUnit, StreamLanguage, StreamParser, syntaxHighlighting } from "@codemirror/language";
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

export interface CodeEditorProps {
  /** Path of the file shown: a new path resets the editor. */
  path: string;
  /** Syntax highlighting (the caller detects it from the file name; the user may override it). */
  language: LanguageId;
  /** The text (with \n line endings). Changes from outside replace the content. */
  value: string;
  readOnly: boolean;
  wrap: boolean;
  onChange?: (value: string) => void;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
}

export function CodeEditor({ path, language, value, readOnly, wrap, onChange, onSave }: CodeEditorProps) {
  const theme = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };
  const parts = useRef({ wrap: new Compartment(), readOnly: new Compartment(), look: new Compartment(), language: new Compartment() });

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
      },
      { dark },
    ),
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
            indentWithTab,
            // Read-only: indenting does nothing, and Tab would move the focus out of the viewer (behind
            // the maximized panel), so swallow it.
            { key: "Tab", run: (view: EditorView) => view.state.readOnly, shift: (view: EditorView) => view.state.readOnly },
          ]),
          basicSetup,
          indentUnit.of("  "),
          p.language.of(PARSERS[language]()),
          p.look.of(look()),
          p.wrap.of(wrap ? EditorView.lineWrapping : []),
          // Read-only still takes focus (like a read-only file in VS Code), so search, selection and
          // copy work in the preview too; it just can't be changed.
          p.readOnly.of(locked(readOnly)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
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
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.language.reconfigure(PARSERS[language]()) });
  }, [language]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: parts.current.readOnly.reconfigure(locked(readOnly)) });
    if (!readOnly) v.contentDOM.focus({ preventScroll: true }); // keep the view where the user was reading
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: parts.current.look.reconfigure(look()) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.palette.mode]);

  return <Box ref={host} sx={{ height: "100%", minHeight: 0, "& .cm-editor": { height: "100%" } }} />;
}
