/**
 * Shell integration: tracks the OSC 133;B marker the backend injects at the end of the prompt.
 *
 * It answers two questions reliably (for bash and busybox sh; other shells simply never send it):
 *   - Is the shell's prompt active (user editing a command), or is a program running?
 *     Active from the marker until the user presses Enter; the next prompt re-arms it.
 *   - Where does the editable command line start? A buffer marker at the prompt line (tracks
 *     scrolling and reflow) plus the cursor column when the marker arrived.
 *
 * With `guess` (the server terminal, whose shell gets no marker) and no marker seen, the prompt is
 * recognised instead: the command line starts after the first "$ ", "# ", "> ", "% ", "❯ " or "» " on
 * the cursor's line. No such prompt there (another prompt style, or a program running): no prompt, so
 * nothing is edited by guesswork.
 */
import type { IMarker, Terminal } from "@xterm/xterm";
import { rowCells, rowEndCol } from "./cells";

export class PromptTracker {
  /** At least one marker was seen: the shell supports integration. */
  seen = false;
  private markedActive = false;
  private marker: IMarker | null = null;
  private startCol = 0;
  /** The farthest the cursor has been (absolute offset): typed spaces at the end leave nothing to see. */
  private farthest = -1;

  /** Prompt is waiting for input (no command running). */
  get active(): boolean {
    return this.seen ? this.markedActive : this.guess && this.guessStart() !== null;
  }

  constructor(
    private t: Terminal,
    private guess = false,
  ) {
    t.onCursorMove(() => {
      const at = this.realCursorAbs();
      if (this.expected !== null && at === this.expected) this.expected = null;
      if (at > this.farthest) this.farthest = at;
    });
    t.parser.registerOscHandler(133, (data) => {
      if (data.startsWith("B")) {
        this.marker?.dispose();
        this.marker = t.registerMarker(0);
        this.startCol = t.buffer.active.cursorX;
        this.seen = true;
        this.markedActive = true;
        this.expected = null;
      }
      return true; // swallow: never rendered
    });
  }

  /** The user submitted the line: a command (or program) runs until the next prompt. */
  commandStarted() {
    this.markedActive = false;
    this.farthest = -1; // the next command line starts afresh (e.g. after `clear` it can be on the same row)
  }

  private get cols() {
    return this.t.cols;
  }

  private abs(row: number, col: number) {
    return row * this.cols + col;
  }

  /** Absolute cell offset (row * cols + col) where the command line starts, or null without a prompt. */
  private startAbs(): number | null {
    if (!this.seen) return this.guess ? this.guessStart() : null;
    if (!this.markedActive || !this.marker || this.marker.isDisposed || this.marker.line < 0) return null;
    return this.abs(this.marker.line, this.startCol);
  }

  /** Without a marker: just after the prompt on the cursor's line (see the top), or null. */
  private guessStart(): number | null {
    const b = this.t.buffer.active;
    if (b.type === "alternate") return null;
    let row = b.baseY + b.cursorY;
    while (row > 0 && b.getLine(row)?.isWrapped) row--; // a long command line wraps onto more rows
    const cells = rowCells(b.getLine(row), this.cols);
    const text = cells.join("");
    const m = /[$#>%❯»] /u.exec(text);
    if (!m) return null;
    // From the text's index back to a column (rowCells gives one string per cell).
    let col = 0;
    for (let len = 0; col < cells.length && len < m.index + m[0].length; col++) len += cells[col].length;
    const start = this.abs(row, col);
    return start <= this.realCursorAbs() ? start : null;
  }

  /**
   * Absolute offset just past the last typed character of the command line. Long lines span several
   * rows: bash leaves them soft-wrapped (isWrapped), busybox redraws them with explicit line breaks,
   * so the input extends at least to the cursor's row, plus any soft-wrapped continuation.
   */
  private endAbs(start: number): number {
    const b = this.t.buffer.active;
    const startRow = Math.floor(start / this.cols);
    let row = Math.max(startRow, b.baseY + b.cursorY);
    while (b.getLine(row + 1)?.isWrapped) row++;
    const lineEnd = rowEndCol(b.getLine(row), this.cols);
    // Spaces typed at the end are blank cells: the line goes at least as far as the cursor went on
    // this row (the cursor may have moved back since, e.g. while selecting by word).
    const far = this.farthest >= start && Math.floor(this.farthest / this.cols) === row ? this.farthest : 0;
    return Math.max(this.abs(row, lineEnd), far, row === startRow ? start : 0);
  }

  /** Editable command line as absolute offsets, or null when no prompt is being edited. */
  inputRange(): { start: number; end: number } | null {
    const start = this.startAbs();
    if (start === null) return null;
    return { start, end: Math.max(this.endAbs(start), this.cursorAbs()) };
  }

  // ---- cursor ------------------------------------------------------------------------------------
  // The shell redraws the cursor asynchronously, so after sending moves we remember where it *will*
  // be; otherwise quick repeated keys would compute from a stale position and drift.
  private expected: number | null = null;

  private realCursorAbs() {
    const b = this.t.buffer.active;
    return this.abs(b.baseY + b.cursorY, b.cursorX);
  }

  cursorAbs(): number {
    return this.expected ?? this.realCursorAbs();
  }

  /** Forget the prediction (the user typed something else; the real cursor is authoritative). */
  resetExpected() {
    this.expected = null;
  }

  /** Characters (not cells: wide chars occupy two cells) between two absolute offsets. */
  private chars(from: number, to: number) {
    const b = this.t.buffer.active;
    let n = 0;
    for (let off = from; off < to; off++) {
      const cell = b.getLine(Math.floor(off / this.cols))?.getCell(off % this.cols);
      if (!cell || cell.getWidth() !== 0) n++; // width 0 = right half of a wide char
    }
    return n;
  }

  /** Keys that move the shell's cursor to `target` (absolute offset inside the input). */
  moveTo(target: number): string {
    const cur = this.cursorAbs();
    const app = this.t.modes.applicationCursorKeysMode;
    const [right, left] = app ? ["\x1bOC", "\x1bOD"] : ["\x1b[C", "\x1b[D"];
    const keys = target >= cur ? right.repeat(this.chars(cur, target)) : left.repeat(this.chars(target, cur));
    this.expected = target;
    return keys;
  }

  // ---- selection ---------------------------------------------------------------------------------

  /** The terminal selection as absolute offsets, if it lies entirely inside the command line. */
  selectionInInput(): { a: number; z: number } | null {
    const range = this.inputRange();
    const sel = this.t.getSelectionPosition();
    if (!range || !sel || !this.t.hasSelection()) return null;
    // getSelectionPosition: 0-based columns/rows, end exclusive.
    const a = this.abs(sel.start.y, sel.start.x);
    const z = this.abs(sel.end.y, sel.end.x);
    if (a < range.start || z > range.end || a >= z) return null;
    return { a, z };
  }

  /** Keys that delete the selection from the command line, or null if it isn't inside the input. */
  deleteSelectionKeys(): string | null {
    const sel = this.selectionInInput();
    if (!sel) return null;
    const keys = this.moveTo(sel.z) + "\x7f".repeat(this.chars(sel.a, sel.z));
    this.expected = sel.a;
    return keys;
  }

  /** Editor-style collapse: Left puts the cursor at the selection's start, Right at its end. */
  collapseKeys(dir: -1 | 1): string | null {
    const sel = this.selectionInInput();
    if (!sel) return null;
    return this.moveTo(dir < 0 ? sel.a : sel.z);
  }
}
