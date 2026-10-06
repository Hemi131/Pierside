import type { IBufferLine } from "@xterm/xterm";

/**
 * Per-cell characters of a buffer row. Wide characters (CJK, emoji) occupy two cells; the second
 * cell repeats the character so column-based word logic stays aligned with the screen.
 */
export function rowCells(line: IBufferLine | undefined, cols: number): string[] {
  const out: string[] = [];
  let prev = " ";
  for (let x = 0; x < cols; x++) {
    const cell = line?.getCell(x);
    if (!cell) {
      out.push(" ");
      continue;
    }
    if (cell.getWidth() === 0) {
      out.push(prev); // right half of a wide character
      continue;
    }
    prev = cell.getChars() || " ";
    out.push(prev);
  }
  return out;
}

/** Column just past the last non-blank cell of a row (0 for an empty row). */
export function rowEndCol(line: IBufferLine | undefined, cols: number): number {
  const cells = rowCells(line, cols);
  let end = cells.length;
  while (end > 0 && cells[end - 1] === " ") end--;
  return end;
}
