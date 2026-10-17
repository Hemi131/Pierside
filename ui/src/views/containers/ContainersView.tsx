import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from "@mui/material";
import FilterListIcon from "@mui/icons-material/FilterList";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import { useEngine } from "../../hooks/useEngine";
import { usePersistentState } from "../../hooks/usePersistentState";
import { projectKey, useActions, usePending } from "../../hooks/useActions";
import { EmptyState, PageHeader, SearchField } from "../../components/common";
import { buildRows, isActive, isSwarmHistory, matches, Sort, SortKey } from "./model";
import { COLS, ContainerRow, ProjectRow } from "./Rows";
import { DownProjectRow, OpenComposeButton } from "./ComposeRows";
import { useResource } from "../../hooks/useResource";
import type { ComposeProjects } from "../../api/compose";
import { UsageCards } from "./UsageCards";
import { useColumnLayout } from "../../components/table/useColumnLayout";
import { inInteractiveTerminal } from "../../utils/keys";

const HEADERS: { key?: SortKey; label: string; align?: "right"; width?: number | string }[] = [
  { key: "name", label: "Name" },
  { key: "image", label: "Image" },
  { key: "status", label: "Status", width: 170 },
  { label: "Port(s)", width: 150 },
  { key: "cpu", label: "CPU (%)", align: "right", width: 90 },
  { key: "started", label: "Last started", width: 130 },
  { label: "Actions", align: "right", width: 160 },
];

export function ContainersView() {
  const { containers, stats } = useEngine();
  const pending = usePending();
  const { bulkAction, deleteContainers } = useActions();

  const [search, setSearch] = useState("");
  const [onlyRunning, setOnlyRunning] = usePersistentState("containers.onlyRunning", false);
  const [showSystem, setShowSystem] = usePersistentState("containers.showSystem", false);
  const [showExtension, setShowExtension] = usePersistentState("containers.showExtension", false);
  const [showSwarmHistory, setShowSwarmHistory] = usePersistentState("containers.showSwarmHistory", false);
  const [expanded, setExpanded] = usePersistentState<Record<string, boolean>>("containers.expanded", {});
  const [sort, setSort] = usePersistentState<Sort>("containers.sort", { key: "name", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  // DOM positions: 1 checkbox, 2 status icon, 3.. = HEADERS (Actions last).
  const layout = useColumnLayout("containers", [
    { pos: 3, label: "Name" },
    { pos: 4, label: "Image", autoHide: 2 },
    { pos: 5, label: "Status", autoHide: 5 },
    { pos: 6, label: "Port(s)", autoHide: 3 },
    { pos: 7, label: "CPU (%)", autoHide: 4 },
    { pos: 8, label: "Last started", autoHide: 1 },
    { pos: 9, label: "Actions", resizable: false },
  ]);

  // Remembered compose projects: file locations for the compose actions, and projects that are down.
  const compose = useResource<ComposeProjects>("/compose/projects", ["container"], 800);
  const composeByName = useMemo(() => new Map((compose.data?.projects ?? []).map((p) => [p.name, p])), [compose.data]);
  const engineType = compose.data?.engine.type ?? "local";

  const all = containers ?? [];
  const visible = useMemo(
    () =>
      all.filter(
        (c) =>
          (showSystem || !c.isSystem) &&
          (showExtension || !c.isExtension) &&
          (showSwarmHistory || !isSwarmHistory(c)) &&
          (!onlyRunning || isActive(c.state)) &&
          matches(c, search.trim()),
      ),
    [all, showSystem, showExtension, showSwarmHistory, onlyRunning, search],
  );
  const rows = useMemo(() => buildRows(visible, sort, stats), [visible, sort, stats]);
  const downProjects = useMemo(() => {
    if (onlyRunning) return [];
    const q = search.trim().toLowerCase();
    const live = new Set(all.map((c) => c.project).filter(Boolean));
    return (compose.data?.projects ?? []).filter((p) => !live.has(p.name) && (!q || p.name.toLowerCase().includes(q)));
  }, [compose.data, all, onlyRunning, search]);
  const byId = useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);

  // Drop selections for containers that disappeared or are filtered out.
  useEffect(() => {
    const ids = new Set(visible.map((c) => c.id));
    setSelected((s) => {
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [visible]);

  // "/" or Ctrl+F focuses search, like Docker Desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, [contenteditable]");
      if ((e.key === "/" && !typing) || (e.key === "f" && (e.ctrlKey || e.metaKey) && !inInteractiveTerminal(e.target))) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("input[data-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
      return next;
    });

  const selectedContainers = [...selected].map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
  const allVisibleSelected = visible.length > 0 && visible.every((c) => selected.has(c.id));
  const searching = search.trim().length > 0;
  const hiddenCount = all.filter((c) => (!showSystem && c.isSystem) || (!showExtension && c.isExtension) || (!showSwarmHistory && isSwarmHistory(c))).length;

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "cpu" || key === "started" ? "desc" : "asc" }));

  return (
    <>
      <PageHeader
        title="Containers"
        subtitle="View all your running containers and compose applications."
        actions={<OpenComposeButton compose={compose.data} onAdded={() => void compose.reload()} />}
      />
      <UsageCards />

      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1.5, minHeight: 40 }}>
        <SearchField value={search} onChange={setSearch} />
        <Tooltip title="Filters">
          <IconButton onClick={(e) => setFilterAnchor(e.currentTarget)} color={showSystem || showExtension || showSwarmHistory ? "primary" : "default"}>
            <FilterListIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
          <MenuItem onClick={() => setShowSystem(!showSystem)}>
            <Checkbox size="small" checked={showSystem} sx={{ p: 0, mr: 1 }} />
            Show system containers (Kubernetes)
          </MenuItem>
          <MenuItem onClick={() => setShowExtension(!showExtension)}>
            <Checkbox size="small" checked={showExtension} sx={{ p: 0, mr: 1 }} />
            Show extension containers
          </MenuItem>
          <MenuItem onClick={() => setShowSwarmHistory(!showSwarmHistory)}>
            <Checkbox size="small" checked={showSwarmHistory} sx={{ p: 0, mr: 1 }} />
            Show stopped swarm task containers (task history)
          </MenuItem>
        </Menu>
        {layout.columnsButton}
        <FormControlLabel
          control={<Switch size="small" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} />}
          label={<Typography variant="body1">Only show running containers</Typography>}
        />
        <Box sx={{ flex: 1 }} />
        {selected.size > 0 && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body1" color="text.secondary" sx={{ mr: 1 }}>
              {selected.size} selected
            </Typography>
            <Button variant="outlined" startIcon={<PlayArrowIcon />} onClick={() => void bulkAction(selectedContainers, "start")}>
              Start
            </Button>
            <Button variant="outlined" startIcon={<StopIcon />} onClick={() => void bulkAction(selectedContainers, "stop")}>
              Stop
            </Button>
            <Button
              variant="contained"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => void deleteContainers(selectedContainers).then(() => setSelected(new Set()))}
            >
              Delete
            </Button>
          </Stack>
        )}
      </Stack>

      {all.length === 0 && downProjects.length === 0 ? (
        <EmptyState icon={<ViewInArOutlinedIcon sx={{ fontSize: 48 }} />} title="Your running containers show here">
          <Typography variant="body1">
            A container is an isolated environment for your code. Run one with <code>docker run</code> or start a compose project with{" "}
            <code>docker compose up</code>.
          </Typography>
        </EmptyState>
      ) : (
        <TableContainer ref={layout.containerRef} component={Paper} variant="outlined" sx={{ flex: "0 1 auto", minHeight: 0 }}>
          <Table ref={layout.tableRef} size="small" stickyHeader sx={[{ tableLayout: "auto" }, layout.tableSx] as never}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={allVisibleSelected}
                    indeterminate={selected.size > 0 && !allVisibleSelected}
                    onChange={(e) => toggle(visible.map((c) => c.id), e.target.checked)}
                    inputProps={{ "aria-label": "Select all" }}
                  />
                </TableCell>
                <TableCell sx={{ width: 36, px: 0 }} />
                {HEADERS.map((h, i) => (
                  <TableCell key={h.label} align={h.align} sx={{ width: h.width }} sortDirection={sort.key === h.key ? sort.dir : false}>
                    {h.key ? (
                      <TableSortLabel active={sort.key === h.key} direction={sort.key === h.key ? sort.dir : "asc"} onClick={() => setSortKey(h.key!)}>
                        {h.label}
                      </TableSortLabel>
                    ) : (
                      h.label
                    )}
                    {layout.resizeHandle(i + 3)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && downProjects.length === 0 && (
                <TableRow>
                  <TableCell colSpan={COLS} sx={{ py: 6, textAlign: "center", color: "text.secondary" }}>
                    No containers match the current filters.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => {
                if (r.kind === "container") {
                  return (
                    <ContainerRow
                      key={r.c.id}
                      c={r.c}
                      stats={stats[r.c.id]}
                      selected={selected.has(r.c.id)}
                      onSelect={(on) => toggle([r.c.id], on)}
                      pending={pending.get(r.c.id)}
                    />
                  );
                }
                const ids = r.containers.map((c) => c.id);
                const nSel = ids.filter((id) => selected.has(id)).length;
                const isOpen = searching || !!expanded[r.name];
                const running = r.containers.filter((c) => c.state === "running");
                return (
                  <Fragment key={`p:${r.source}:${r.name}`}>
                    <ProjectRow
                      g={r}
                      expanded={isOpen}
                      onToggleExpand={() => setExpanded((e) => ({ ...e, [r.name]: !isOpen }))}
                      checked={nSel === ids.length}
                      indeterminate={nSel > 0 && nSel < ids.length}
                      onSelect={(on) => toggle(ids, on)}
                      cpu={running.length ? running.reduce((s, c) => s + (stats[c.id]?.cpu ?? 0), 0) : null}
                      pending={pending.get(projectKey(r.name))}
                      compose={r.source === "compose" ? composeByName.get(r.name) : undefined}
                      engineType={engineType}
                    />
                    {isOpen &&
                      r.containers.map((c) => (
                        <ContainerRow
                          key={c.id}
                          c={c}
                          nested
                          stats={stats[c.id]}
                          selected={selected.has(c.id)}
                          onSelect={(on) => toggle([c.id], on)}
                          pending={pending.get(c.id) ?? pending.get(projectKey(r.name))}
                        />
                      ))}
                  </Fragment>
                );
              })}
              {downProjects.map((p) => (
                <DownProjectRow key={`down:${p.name}`} p={p} engine={engineType} onChanged={() => void compose.reload()} />
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {hiddenCount > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {hiddenCount} system, extension or swarm-history container{hiddenCount === 1 ? "" : "s"} hidden · change in Filters
        </Typography>
      )}
    </>
  );
}
