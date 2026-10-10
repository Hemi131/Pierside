/**
 * Bracket pair colours (like VS Code's): (), [] and {} take one of three colours by nesting depth;
 * a closing bracket without a partner is marked as an error. Brackets in strings and comments
 * don't count. Colours come from the editor theme (classes cm-bracket-0..2, cm-bracket-unmatched).
 */
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const marks = [0, 1, 2].map((i) => Decoration.mark({ class: `cm-bracket-${i}` }));
const unmatched = Decoration.mark({ class: "cm-bracket-unmatched" });
const OPEN = "([{";
const CLOSE = ")]}";
/** Syntax nodes whose brackets are text, not structure. */
const TEXT_NODE = /string|comment|regexp|literal|character|^char$/i;
/**
 * Counting starts at the top of the file up to this size; in bigger files it starts this far above
 * the visible part (the depth there is guessed as 0), so scrolling stays smooth.
 */
const SCAN_LIMIT = 200_000;

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const ranges = view.visibleRanges;
  if (!ranges.length) return builder.finish();
  const end = ranges[ranges.length - 1].to;
  const start = end > SCAN_LIMIT ? Math.max(0, ranges[0].from - 20_000) : 0;
  // Stretches to skip, in order.
  const skip: [number, number][] = [];
  syntaxTree(state).iterate({
    from: start,
    to: end,
    enter: (n) => {
      if (n.type.isTop) return;
      if (TEXT_NODE.test(n.type.name)) {
        skip.push([n.from, n.to]);
        return false;
      }
    },
  });
  const text = state.doc.sliceString(start, end);
  const stack: number[] = [];
  let s = 0;
  let r = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const o = OPEN.indexOf(ch);
    const c = o < 0 ? CLOSE.indexOf(ch) : -1;
    if (o < 0 && c < 0) continue;
    const pos = start + i;
    while (s < skip.length && skip[s][1] <= pos) s++;
    if (s < skip.length && skip[s][0] <= pos) continue;
    while (r < ranges.length && ranges[r].to <= pos) r++;
    const visible = r < ranges.length && ranges[r].from <= pos;
    if (o >= 0) {
      if (visible) builder.add(pos, pos + 1, marks[stack.length % 3]);
      stack.push(o);
    } else if (stack.length && stack[stack.length - 1] === c) {
      stack.pop();
      if (visible) builder.add(pos, pos + 1, marks[stack.length % 3]);
    } else if (visible) builder.add(pos, pos + 1, unmatched);
  }
  return builder.finish();
}

export const bracketColors = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = build(u.view);
    }
  },
  { decorations: (p) => p.decorations },
);
