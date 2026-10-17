// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// Control characters other than tab, line feed, carriage return, BEL and ESC (those two end and start
// escape sequences, so they go only after the escape pass).
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x06\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g;
// Any escape sequence: CSI (ESC [ … final), OSC (ESC ] … BEL / ST), charset (ESC ( B etc.), or a single ESC x.
// eslint-disable-next-line no-control-regex
// An OSC that never ends (at the end of the line) counts as one too, so it goes whole.
const ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\x1b[()*+#%][\x20-\x7e]|\x1b[\x20-\x7e]/g;
// Colours (SGR) and finished OSC 8 links: an unfinished link would swallow the lines after it.
// eslint-disable-next-line no-control-regex
const KEEP_RE = /^(?:\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))$/;
// A BEL or ESC left over after the escape pass (outside any sequence, e.g. a lone ESC at the end).
// eslint-disable-next-line no-control-regex
const LEFTOVER_RE = /[\x07\x1b]/g;
// eslint-disable-next-line no-control-regex
const NEEDS_CLEANING = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/**
 * A log line as the log view may write it into xterm: colours (SGR, ESC[…m) and OSC 8 links stay;
 * everything that moves the cursor, clears or switches the screen, or resets the terminal goes (a TTY
 * container's logs carry those, and they would wreck scrolling, search and copy). So do other control
 * characters except tab and carriage return.
 *
 * The order matters: control characters are removed first, so that removing one can't join the pieces
 * around it into a new sequence (ESC NUL [2J); then the sequences; then what is left of BEL and ESC (a
 * lone ESC at the end of a line, an OSC that never ends), which would otherwise start a sequence that
 * swallows the following lines.
 */
export function logSafe(s: string): string {
  if (!NEEDS_CLEANING.test(s)) return s;
  const kept: string[] = [];
  const out = s
    .replace(CONTROL_RE, "")
    .replace(ESCAPE_RE, (seq) => {
      if (!KEEP_RE.test(seq)) return "";
      kept.push(seq);
      return `\u0000${kept.length - 1}\u0000`; // set aside, so the leftover pass can't touch them
    })
    .replace(LEFTOVER_RE, "");
  // eslint-disable-next-line no-control-regex
  return out.replace(/\x00(\d+)\x00/g, (_m, i: string) => kept[Number(i)]);
}

export const sgr = (codes: string, text: string) => `\x1b[${codes}m${text}\x1b[0m`;

/** 24-bit foreground colour escape from #rrggbb. */
export function fg(hex: string, text: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m${text}\x1b[39m`;
}
