/**
 * Editor-like keys for the Exec shell.
 *
 * Line editing (only while the shell prompt owns the screen; full-screen apps such as vim, less and
 * top use the alternate buffer and get raw keys). The sequences were verified to work in both bash
 * (GNU readline) and busybox sh:
 *   Ctrl+Left / Ctrl+Right   word back / forward      -> ESC b / ESC f
 *   Ctrl+Backspace           delete previous word      -> ESC DEL
 *   Ctrl+Delete              delete next word          -> ESC d
 *
 * Keyboard selection (terminal text, for copying; the shell itself has no selection):
 *   Shift+Left/Right/Up/Down     extend by character / line, starting at the cursor
 *   Ctrl+Shift+Left/Right        extend by word
 *   Shift+Home / Shift+End       extend to start / end of the line
 * Then Ctrl+C (or Ctrl+Shift+C) copies. Any other key ends keyboard selection.
 *
 * With shell integration (see promptTracker.ts), a selection inside the command line behaves like
 * in an editor: the shell's cursor follows the moving end while selecting (clamped to the command
 * line; Shift+Home/End go to its start/end), Left/Right collapse the selection to its start/end,
 * Backspace/Delete remove it, and typing or pasting replaces it. The edit is done by
 * sending ordinary cursor-move and backspace keys, so the shell stays the owner of the line.
 */
import type { Terminal } from "@xterm/xterm";
import type { PromptTracker } from "./promptTracker";
import { rowCells, rowEndCol } from "./cells";

type Send = (data: string) => void;

const EDIT: Record<string, string> = {
  ArrowLeft: "\x1bb",
  ArrowRight: "\x1bf",
  Backspace: "\x1b\x7f",
  Delete: "\x1bd",
};

const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

/** Composable key handler for xterm: returns false when it handled the key. */
export function terminalKeyHandler(t: Terminal, send: Send, prompt: PromptTracker): (e: KeyboardEvent) => boolean {
  // Keyboard selection state, as linear offsets (row * cols + col) in the buffer.
  let anchor: number | null = null;
  let focus = 0;

  const cols = () => t.cols;
  const bufferLen = () => t.buffer.active.length * cols();
  const cursorOffset = () => {
    const b = t.buffer.active;
    return (b.baseY + b.cursorY) * cols() + b.cursorX;
  };
  // Column-aligned (wide characters span two cells), unlike translateToString().
  const cellsOf = (row: number) => rowCells(t.buffer.active.getLine(row), cols());
  const endColOf = (row: number) => rowEndCol(t.buffer.active.getLine(row), cols());

  const apply = () => {
    if (anchor === null) return;
    const start = Math.min(anchor, focus);
    const len = Math.abs(focus - anchor);
    if (len === 0) {
      t.clearSelection();
      return;
    }
    t.select(start % cols(), Math.floor(start / cols()), len);
    // Keep the moving end visible.
    const focusRow = Math.floor(focus / cols());
    const b = t.buffer.active;
    if (focusRow < b.viewportY) t.scrollLines(focusRow - b.viewportY);
    else if (focusRow >= b.viewportY + t.rows) t.scrollLines(focusRow - (b.viewportY + t.rows) + 1);
  };

  const wordStep = (from: number, dir: -1 | 1): number => {
    const row = Math.floor(from / cols());
    const text = cellsOf(row);
    let col = from % cols();
    if (dir < 0) {
      if (col === 0) return Math.max(0, from - 1);
      col--;
      while (col > 0 && !isWordChar(text[col])) col--;
      while (col > 0 && isWordChar(text[col - 1])) col--;
    } else {
      if (col >= cols() - 1) return Math.min(bufferLen(), from + 1);
      while (col < cols() && isWordChar(text[col])) col++;
      while (col < cols() && !isWordChar(text[col])) col++;
      // Don't run past the end of the text on this row.
      col = Math.min(col, endColOf(row));
    }
    return row * cols() + col;
  };

  // A mouse selection (or clearing it) takes over from keyboard selection.
  let applying = false;
  t.onSelectionChange(() => {
    if (!applying && anchor !== null && !t.hasSelection()) anchor = null;
  });

  return (e) => {
    if (e.type !== "keydown") return true;
    const alternate = t.buffer.active.type === "alternate";
    // With shell integration we know exactly whether the prompt is being edited; otherwise assume
    // "prompt" unless a full-screen program switched to the alternate screen.
    const atPrompt = prompt.seen ? prompt.active : !alternate;

    // ---- keyboard selection (Shift + navigation keys) ----
    const nav = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key);
    if (e.shiftKey && nav && !e.altKey && !e.metaKey && !alternate) {
      if (anchor === null) {
        const sel = t.getSelectionPosition();
        if (sel && t.hasSelection()) {
          // Continue from an existing (mouse) selection: keep its start, move its end.
          anchor = sel.start.y * cols() + sel.start.x;
          focus = sel.end.y * cols() + sel.end.x;
        } else {
          anchor = focus = prompt.active ? prompt.cursorAbs() : cursorOffset();
        }
      }
      const row = Math.floor(focus / cols());
      // Editing a command line: keep the selection inside it and let the shell's cursor follow the
      // moving end (like a text editor's caret).
      const input = prompt.active ? prompt.inputRange() : null;
      const inInput = !!input && anchor >= input.start && anchor <= input.end;
      switch (e.key) {
        case "ArrowLeft":
          focus = e.ctrlKey ? wordStep(focus, -1) : Math.max(0, focus - 1);
          break;
        case "ArrowRight":
          focus = e.ctrlKey ? wordStep(focus, 1) : Math.min(bufferLen(), focus + 1);
          break;
        case "ArrowUp":
          focus = Math.max(0, focus - cols());
          break;
        case "ArrowDown":
          focus = Math.min(bufferLen(), focus + cols());
          break;
        case "Home":
          focus = row * cols();
          break;
        case "End":
          focus = row * cols() + endColOf(row);
          break;
      }
      if (inInput && input) {
        if (e.key === "Home") focus = input.start;
        if (e.key === "End") focus = input.end;
        focus = Math.min(Math.max(focus, input.start), input.end);
      }
      applying = true;
      apply();
      applying = false;
      if (inInput) send(prompt.moveTo(focus));
      e.preventDefault();
      return false;
    }

    // Copy/paste shortcuts are handled elsewhere; plain modifier presses don't end a selection.
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return true;
    if ((e.ctrlKey || e.metaKey) && ["c", "C", "v", "V"].includes(e.key)) return true;
    anchor = null;

    // ---- editor-style collapse: Left/Right with a selection jump to its start/end ----
    const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (bare && prompt.active && t.hasSelection() && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const keys = prompt.collapseKeys(e.key === "ArrowLeft" ? -1 : 1);
      if (keys !== null) {
        send(keys);
        t.clearSelection();
        e.preventDefault();
        return false;
      }
    }
    if (bare && (e.key === "ArrowUp" || e.key === "ArrowDown")) t.clearSelection(); // history

    if (e.key === "Enter" && !e.shiftKey) prompt.commandStarted();

    // ---- editor-like selection editing (needs shell integration to know the input's extent) ----
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (plain && prompt.active && t.hasSelection()) {
      const replacing = e.key.length === 1; // printable character
      if (replacing || e.key === "Backspace" || e.key === "Delete") {
        const keys = prompt.deleteSelectionKeys();
        if (keys) {
          send(keys);
          t.clearSelection();
          if (!replacing) {
            e.preventDefault();
            return false;
          }
          prompt.resetExpected(); // the typed character moves the cursor once more
          return true; // xterm now sends the typed character, which replaces the selection
        }
      }
    }

    // Any other key moves the real cursor in ways we don't predict (selection edits above still
    // needed the prediction, e.g. Backspace right after fast Shift+Left presses).
    prompt.resetExpected();

    // ---- word-wise line editing (prompt only) ----
    if (atPrompt && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && EDIT[e.key]) {
      send(EDIT[e.key]);
      e.preventDefault();
      return false;
    }
    return true;
  };
}
