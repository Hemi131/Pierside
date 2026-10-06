/**
 * Shell integration: tracks the OSC 133;B marker the backend injects at the end of the prompt.
 *
 * It answers two questions reliably (for bash and busybox sh; other shells simply never send it):
 *   - Is the shell's prompt active (user editing a command), or is a program running?
 *     Active from the marker until the user presses Enter; the next prompt re-arms it.
 *   - Where does the editable command line start? A buffer marker at the prompt line (tracks
 *     scrolling and reflow) plus the cursor column when the marker arrived.
 */
import type { IMarker, Terminal } from "@xterm/xterm";
import { rowEndCol } from "./cells";

export class PromptTracker {
  /** At least one marker was seen: the shell supports integration. */
  seen = false;
  /** Prompt is waiting for input (no command running). */
  active = false;
  private marker: IMarker | null = null;
  private startCol = 0;

  constructor(private t: Terminal) {
    t.onCursorMove(() => {
      if (this.expected !== null && this.realCursorAbs() === this.expected) this.expected = null;
    });
    t.parser.registerOscHandler(133, (data) => {
      if (data.startsWith("B")) {
        this.marker?.dispose();
        this.marker = t.registerMarker(0);
        this.startCol = t.buffer.active.cursorX;
        this.seen = true;
        this.active = true;
        this.expected = null;
      }
      return true; // swallow: never rendered
    });
  }

  /** The user submitted the line: a command (or program) runs until the next prompt. */
  commandStarted() {
    this.active = false;
  }

  private get cols() {
    return this.t.cols;
  }

  private abs(row: number, col: number) {
    return row * this.cols + col;
  }

  /** Absolute cell offset (row * cols + col) where the command line starts, or null without a prompt. */
  private startAbs(): number | null {
    if (!this.active || !this.marker || this.marker.isDisposed || this.marker.line < 0) return null;
    return this.abs(this.marker.line, this.startCol);
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
    return Math.max(this.abs(row, lineEnd), row === startRow ? start : 0);
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
