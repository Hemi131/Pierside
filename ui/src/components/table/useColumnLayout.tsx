/**
 * Column layout for list tables, without changing how rows render:
 *   - the last (Actions) column is sticky on the right, so it stays visible when scrolling sideways;
 *   - optional columns hide automatically, in priority order, only when the table would otherwise
 *     overflow its container (so the normal layout is untouched); each one comes back once the
 *     container is as wide as the table needed with it. The user can force any of them on/off in a
 *     "Columns" menu (persisted per table);
 *   - columns can be resized by dragging a header border. Until the first drag the table keeps its
 *     normal automatic layout; the first drag snapshots the current widths (so nothing jumps), then
 *     switches to fixed widths. "Reset column widths" returns to automatic.
 * Columns are addressed by their 1-based DOM position (nth-of-type), so row components stay as-is.
 */
import { MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Checkbox, Divider, IconButton, ListItemText, Menu, MenuItem, Tooltip, Typography } from "@mui/material";
import ViewColumnOutlinedIcon from "@mui/icons-material/ViewColumnOutlined";
import type { SxProps, Theme } from "@mui/material";
import { usePersistentState } from "../../hooks/usePersistentState";

export interface ColumnDef {
  /** 1-based position of the column in each row. */
  pos: number;
  label: string;
  /** Auto-hide order when the table overflows (1 hides first). Omit = never auto-hide. */
  autoHide?: number;
  /** Whether the user may hide it from the Columns menu (default: true when autoHide is set). */
  hideable?: boolean;
  /** Whether it can be resized by dragging (default true). */
  resizable?: boolean;
}

type Visibility = Record<number, boolean>; // explicit user choice per position
type Widths = Record<number, number>;

const MIN_WIDTH = 48;
const ROW_HEIGHT = 46;

/** Width a vertical scrollbar takes in this app (measured once; the app styles its scrollbars). */
let cachedScrollbarWidth: number | null = null;
function scrollbarWidth(): number {
  if (cachedScrollbarWidth === null) {
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll";
    document.body.appendChild(probe);
    cachedScrollbarWidth = probe.offsetWidth - probe.clientWidth;
    probe.remove();
  }
  return cachedScrollbarWidth;
}

export function useColumnLayout(tableId: string, columns: ColumnDef[]) {
  // Callback refs: the table may mount later (e.g. after data loads), observers attach then.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [table, setTable] = useState<HTMLTableElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const tableEl = useRef<HTMLTableElement | null>(null);
  boxRef.current = box;
  tableEl.current = table;
  // Auto-hidden columns (in hiding order) and the table width each one needed to be shown.
  const [autoHidden, setAutoHidden] = useState<number[]>([]);
  const needWidth = useRef<Record<number, number>>({});
  const [visibility, setVisibility] = usePersistentState<Visibility>(`columns.${tableId}.visible`, {});
  const [widths, setWidths] = usePersistentState<Widths>(`columns.${tableId}.widths`, {});
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const fixed = Object.keys(widths).length > 0;

  // Fit check: runs whenever the container or the table changes size (resize, new rows, ...).
  const check = useRef<() => void>(() => undefined);
  check.current = () => {
    const box = boxRef.current;
    const table = tableEl.current;
    if (!box || !table) return;
    const avail = box.clientWidth;
    if (fixed) return; // user-set widths: they chose the size; the table scrolls (Actions stays pinned)
    if (table.scrollWidth > avail + 1) {
      const next = columns
        .filter((c) => c.autoHide !== undefined && visibility[c.pos] === undefined && !autoHidden.includes(c.pos))
        .sort((a, b) => a.autoHide! - b.autoHide!)[0];
      if (next) {
        needWidth.current[next.pos] = table.scrollWidth;
        setAutoHidden([...autoHidden, next.pos]);
      }
    } else if (autoHidden.length) {
      const last = autoHidden[autoHidden.length - 1];
      // Bring it back only if it would still fit with a vertical scrollbar. A column can change the row
      // height (e.g. Port(s) with several ports), so hiding it can make the list short enough to lose
      // its scrollbar, which adds that width, which would show the column again, bring the scrollbar
      // back, and hide it again: an endless loop at some window sizes. Judging the width as if the
      // scrollbar were there makes the answer the same either way.
      const style = getComputedStyle(box);
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      const scrollbarNow = Math.max(0, box.offsetWidth - box.clientWidth - borders);
      const withScrollbar = avail + scrollbarNow - scrollbarWidth();
      if (withScrollbar >= (needWidth.current[last] ?? Infinity)) setAutoHidden(autoHidden.slice(0, -1));
    }
  };
  useEffect(() => {
    if (!box || !table) return;
    const ro = new ResizeObserver(() => check.current());
    ro.observe(box);
    ro.observe(table);
    check.current();
    return () => ro.disconnect();
  }, [box, table]);
  // Re-check after each hide/unhide step (the table re-renders narrower/wider).
  useEffect(() => {
    requestAnimationFrame(() => check.current());
  }, [autoHidden, visibility, fixed]);

  const isVisible = useCallback(
    (c: ColumnDef) => {
      if (visibility[c.pos] !== undefined) return visibility[c.pos];
      return !autoHidden.includes(c.pos);
    },
    [visibility, autoHidden],
  );

  const hidden = useMemo(() => columns.filter((c) => !isVisible(c)).map((c) => c.pos), [columns, isVisible]);

  // ---- resizing ----
  const startResize = useCallback(
    (pos: number, e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!table) return;
      const headerCells = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead tr:first-child > th"));
      // First drag: freeze the current automatic layout so nothing jumps.
      let base: Widths = { ...widths };
      if (!fixed) {
        base = {};
        headerCells.forEach((th, i) => {
          if (th.offsetWidth > 0) base[i + 1] = th.offsetWidth;
        });
      }
      const startX = e.clientX;
      const startW = base[pos] ?? headerCells[pos - 1]?.offsetWidth ?? 100;
      const onMove = (ev: MouseEvent) => {
        const w = Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX));
        setWidths({ ...base, [pos]: w });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widths, fixed, setWidths, table],
  );

  /** Put inside a header cell (header cells are position: sticky, which anchors the handle). */
  const resizeHandle = (pos: number) => {
    const def = columns.find((c) => c.pos === pos);
    if (def && def.resizable === false) return null;
    return (
      <Box
        onMouseDown={(e) => startResize(pos, e)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setWidths({});
        }}
        title="Drag to resize · double-click to reset all widths"
        sx={{
          position: "absolute",
          top: 0,
          right: -3,
          width: 7,
          height: "100%",
          cursor: "col-resize",
          zIndex: 3,
          "&:hover::after, &:active::after": { bgcolor: "primary.main" },
          "&::after": { content: '""', position: "absolute", left: 3, top: "25%", height: "50%", width: "1px", bgcolor: "divider" },
        }}
      />
    );
  };

  // ---- styles ----
  const tableSx: SxProps<Theme> = useMemo(() => {
    const sx: Record<string, unknown> = {
      // Same row height in every list: rows with a second line (container name + ID) are this tall,
      // so single-line rows (images, plain volumes) get it as a minimum.
      "& tbody td": { height: ROW_HEIGHT },
      // Sticky Actions column (last), opaque so content scrolls underneath it.
      "& th:last-of-type, & td:last-of-type": {
        position: "sticky",
        right: 0,
        zIndex: 2,
        bgcolor: "background.paper",
        boxShadow: (t: Theme) => `inset 1px 0 0 ${t.palette.divider}`,
      },
      "& thead th:last-of-type": { zIndex: 4 },
      // Keep row hover/selected tints on the sticky cell too.
      "& tr.MuiTableRow-hover:hover > td:last-of-type": {
        backgroundImage: (t: Theme) => `linear-gradient(${t.palette.action.hover}, ${t.palette.action.hover})`,
      },
      "& tr.Mui-selected > td:last-of-type": {
        backgroundImage: (t: Theme) => `linear-gradient(${t.palette.action.selected}, ${t.palette.action.selected})`,
      },
    };
    for (const pos of hidden) sx[`& th:nth-of-type(${pos}), & td:nth-of-type(${pos})`] = { display: "none" };
    if (fixed) {
      sx.tableLayout = "fixed";
      const total = Object.entries(widths)
        .filter(([pos]) => !hidden.includes(Number(pos)))
        .reduce((s, [, w]) => s + w, 0);
      sx.minWidth = total;
      for (const [pos, w] of Object.entries(widths)) sx[`& thead th:nth-of-type(${pos})`] = { width: w };
      sx["& td"] = { overflow: "hidden", textOverflow: "ellipsis" };
    }
    return sx as SxProps<Theme>;
  }, [hidden, fixed, widths]);

  // ---- menu ----
  const hideable = columns.filter((c) => c.hideable ?? c.autoHide !== undefined);
  const columnsButton = (
    <>
      <Tooltip title="Columns">
        <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="Columns" color={hidden.length || fixed ? "primary" : "default"}>
          <ViewColumnOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 0.5 }}>
          Show columns
        </Typography>
        {hideable.map((c) => {
          const on = isVisible(c);
          const auto = visibility[c.pos] === undefined;
          return (
            <MenuItem key={c.pos} onClick={() => setVisibility({ ...visibility, [c.pos]: !on })} dense>
              <Checkbox size="small" checked={on} sx={{ p: 0, mr: 1 }} />
              <ListItemText
                primary={c.label}
                secondary={auto && c.autoHide !== undefined ? (on ? "auto" : "auto: hidden to fit") : undefined}
                secondaryTypographyProps={{ fontSize: 11 }}
              />
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem dense disabled={Object.keys(visibility).length === 0} onClick={() => setVisibility({})}>
          Automatic (fit to width)
        </MenuItem>
        <MenuItem dense disabled={!fixed} onClick={() => setWidths({})}>
          Reset column widths
        </MenuItem>
      </Menu>
    </>
  );

  return { containerRef: setBox, tableRef: setTable, tableSx, resizeHandle, columnsButton };
}
