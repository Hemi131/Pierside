/**
 * "Copy as Markdown": turn the lines under the terminal selection into a snippet for an issue or a
 * chat message: a header naming the source and time range, then the lines in a code block, each
 * with its full timestamp (even when timestamps are hidden on screen).
 */
import type { Terminal } from "@xterm/xterm";

/**
 * The entries of `visible` (the lines written to the terminal, in order) that the selection covers.
 * Terminal rows aren't lines: long lines wrap over several rows, and the terminal may have dropped
 * rows from the top that `visible` still holds, so rows are mapped to lines counting from the end.
 */
export function selectedEntries<T>(t: Terminal, visible: T[]): T[] | null {
  const pos = t.getSelectionPosition();
  if (!pos) return null;
  const b = t.buffer.active;
  const lineOfRow: number[] = [];
  let line = -1;
  for (let r = 0; r < b.length; r++) {
    if (!b.getLine(r)?.isWrapped) line++;
    lineOfRow.push(line);
  }
  // Output ends with a newline, so the cursor sits on the first row after the last line.
  const cursorRow = b.baseY + b.cursorY;
  const total = lineOfRow[cursorRow] ?? line + 1;
  const offset = visible.length - total;
  // IBufferRange rows are 0-based in practice (the typings say 1-based).
  let endRow = pos.end.y;
  if (pos.end.x <= 0 && endRow > pos.start.y) endRow--; // selection ends at the very start of a row
  const first = lineOfRow[Math.max(0, pos.start.y)];
  const last = lineOfRow[Math.min(endRow, cursorRow - 1)];
  if (first === undefined || last === undefined || last < first) return null;
  return visible.slice(Math.max(0, offset + first), Math.max(0, offset + last + 1));
}

/** A code fence that can't be closed by the content itself. */
function fenceFor(body: string): string {
  let fence = "```";
  while (body.includes(fence)) fence += "`";
  return fence;
}

export function markdownSnippet(source: string, lines: string[], from?: string, to?: string): string {
  const body = lines.join("\n");
  const fence = fenceFor(body);
  const range = from ? (to && to !== from ? ` · ${from} → ${to}` : ` · ${from}`) : "";
  const count = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  return `**${source}** logs${range} (${count})\n\n${fence}text\n${body}\n${fence}\n`;
}
