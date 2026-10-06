import type { Terminal } from "@xterm/xterm";
import { copyText } from "../../utils/format";
import { report } from "../../diagnostics";

/**
 * Clipboard shortcuts for an xterm instance.
 *
 * interactive (Exec shell), like Windows Terminal:
 *   Ctrl+C        copies when text is selected (then clears the selection); otherwise sends ^C (SIGINT)
 *   Ctrl+Shift+C  always copies the selection (never sends ^C)
 *   Ctrl+V / Ctrl+Shift+V  paste
 * read-only (Logs):
 *   Ctrl+C / Ctrl+Shift+C copy the selection, Ctrl+A selects everything
 * Cmd is treated like Ctrl on macOS.
 *
 * Paste is done explicitly (clipboard read + term.paste) instead of relying on the browser's paste
 * event: in Rancher Desktop, Ctrl+V is bound to the app's Edit > Paste menu, which targets the main
 * window rather than the extension view, so the terminal never receives a paste event.
 */
type ClipboardOpts = {
  interactive: boolean;
  onCopy?: (text: string) => void;
  onPasteError?: (message: string) => void;
  /** Called right before pasting (e.g. to delete a selected part of the command line first). */
  beforePaste?: () => void;
};

/** For terminals with a single key handler (Logs). */
export function attachClipboardKeys(t: Terminal, opts: ClipboardOpts) {
  t.attachCustomKeyEventHandler(clipboardKeyHandler(t, opts));
}

/** Composable handler: returns false when it handled the key (xterm convention). */
export function clipboardKeyHandler(t: Terminal, opts: ClipboardOpts): (e: KeyboardEvent) => boolean {
  // If a native paste event does arrive right after our explicit paste, drop it (no double paste).
  let suppressNativePasteUntil = 0;
  const onNativePaste = (e: ClipboardEvent) => {
    if (Date.now() < suppressNativePasteUntil) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  t.element?.addEventListener("paste", onNativePaste, true);

  const paste = () => {
    suppressNativePasteUntil = Date.now() + 1000;
    if (!navigator.clipboard?.readText) {
      opts.onPasteError?.("Clipboard access isn't available here");
      return;
    }
    navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) return;
        opts.beforePaste?.();
        t.paste(text);
      })
      .catch((err) => {
        suppressNativePasteUntil = 0;
        const message = String((err as Error)?.message ?? err);
        report("paste-failed", { message });
        opts.onPasteError?.(`Couldn't read the clipboard: ${message}`);
      });
  };

  return (e) => {
    if (e.type !== "keydown" || e.altKey) return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return true;
    const key = e.key.toLowerCase();

    if (key === "c") {
      if (t.hasSelection()) {
        const text = t.getSelection();
        void copyText(text).then(() => opts.onCopy?.(text));
        if (opts.interactive) t.clearSelection(); // next Ctrl+C interrupts again
        e.preventDefault();
        return false;
      }
      // Nothing selected: the shift variant is "copy" only; plain Ctrl+C goes to the process as ^C.
      if (e.shiftKey || !opts.interactive) {
        e.preventDefault();
        return false;
      }
      return true;
    }

    if (opts.interactive && key === "v") {
      e.preventDefault(); // otherwise xterm sends ^V to the shell
      paste();
      return false;
    }

    if (!opts.interactive && key === "a") {
      e.preventDefault();
      t.selectAll();
      return false;
    }
    return true;
  };
}
