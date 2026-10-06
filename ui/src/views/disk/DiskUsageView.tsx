import { useState } from "react";
import { Box, Button, CircularProgress, Link, Paper, Stack, Tooltip, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import CleaningServicesOutlinedIcon from "@mui/icons-material/CleaningServicesOutlined";
import { api } from "../../api/ddclient";
import { useResource } from "../../hooks/useResource";
import { href } from "../../hooks/useRoute";
import { EmptyState, PageHeader } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { formatBytes } from "../../utils/format";

interface Item {
  id: string;
  name: string;
  size: number;
  inUse: boolean;
  state?: string;
}
interface Category {
  count: number;
  active: number;
  size: number;
  reclaimable: number;
  top: Item[];
}
type Kind = "images" | "containers" | "volumes" | "buildCache";
type DiskUsage = Record<Kind, Category>;

const CATEGORIES: {
  kind: Kind;
  label: string;
  color: string;
  icon: JSX.Element;
  activeLabel: string;
  cleanLabel: string;
  confirm: string;
  link?: (i: Item) => string;
}[] = [
  {
    kind: "images",
    label: "Images",
    color: "#1d63ed",
    icon: <LayersOutlinedIcon />,
    activeLabel: "in use",
    cleanLabel: "Remove unused images",
    confirm: "Every image not used by a container will be deleted. That includes Rancher Desktop's own images that aren't in use right now; they are downloaded again when needed.",
    link: (i) => href("images", i.name.includes("<none>") ? i.id : i.name),
  },
  {
    kind: "containers",
    label: "Containers",
    color: "#2e7d32",
    icon: <ViewInArOutlinedIcon />,
    activeLabel: "running",
    cleanLabel: "Remove stopped containers",
    confirm: "Every stopped container will be removed, with the files it wrote (its writable layer). Volumes are kept.",
    link: (i) => href("containers", i.id),
  },
  {
    kind: "volumes",
    label: "Volumes",
    color: "#ef6c00",
    icon: <StorageOutlinedIcon />,
    activeLabel: "in use",
    cleanLabel: "Remove unused volumes",
    confirm: "Every volume not used by a container will be permanently deleted with all its data.",
    link: (i) => href("volumes", i.name),
  },
  {
    kind: "buildCache",
    label: "Build cache",
    color: "#7b1fa2",
    icon: <BuildOutlinedIcon />,
    activeLabel: "in use",
    cleanLabel: "Clear build cache",
    confirm: "The build cache will be cleared. Your next image builds will take longer.",
  },
];

function UsageBar({ data }: { data: DiskUsage }) {
  const total = CATEGORIES.reduce((s, c) => s + data[c.kind].size, 0);
  const reclaimable = CATEGORIES.reduce((s, c) => s + data[c.kind].reclaimable, 0);
  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
      <Stack direction="row" alignItems="baseline" spacing={2} sx={{ mb: 1.5 }}>
        <Typography variant="h2">{formatBytes(total)}</Typography>
        <Typography color="text.secondary">used by Docker</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography color="text.secondary">
          <b>{formatBytes(reclaimable)}</b> can be reclaimed
        </Typography>
      </Stack>
      <Box sx={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", bgcolor: "action.hover" }}>
        {CATEGORIES.map((c) => {
          const size = data[c.kind].size;
          if (!total || !size) return null;
          return (
            <Tooltip key={c.kind} title={`${c.label}: ${formatBytes(size)}`}>
              <Box sx={{ width: `${(size / total) * 100}%`, minWidth: 3, bgcolor: c.color }} />
            </Tooltip>
          );
        })}
      </Box>
      <Stack direction="row" spacing={2.5} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap>
        {CATEGORIES.map((c) => (
          <Stack key={c.kind} direction="row" spacing={0.75} alignItems="center">
            <Box sx={{ width: 10, height: 10, borderRadius: "2px", bgcolor: c.color }} />
            <Typography variant="body2" color="text.secondary">
              {c.label} {formatBytes(data[c.kind].size)}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}

function CategoryCard({ def, cat, busy, onClean }: { def: (typeof CATEGORIES)[number]; cat: Category; busy: boolean; onClean: () => void }) {
  const canClean = cat.reclaimable > 0 || (def.kind === "containers" && cat.count > cat.active);
  return (
    <Paper variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1 }}>
        <Box sx={{ color: def.color, display: "flex" }}>{def.icon}</Box>
        <Typography variant="h3" sx={{ flex: 1 }}>
          {def.label}
        </Typography>
        <Typography variant="h3">{formatBytes(cat.size)}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        {cat.count} total · {cat.active} {def.activeLabel} · <b>{formatBytes(cat.reclaimable)}</b> reclaimable
      </Typography>
      <Box sx={{ my: 1.5, flex: 1 }}>
        {cat.top.length === 0 ? (
          <Typography variant="body2" color="text.disabled">
            Nothing here.
          </Typography>
        ) : (
          cat.top.map((i) => (
            <Stack key={i.id} direction="row" spacing={1} alignItems="center" sx={{ py: 0.35 }}>
              <Tooltip title={i.inUse ? `In use${i.state ? ` (${i.state})` : ""}` : "Unused"}>
                <Box sx={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, bgcolor: i.inUse ? "success.main" : "text.disabled" }} />
              </Tooltip>
              {def.link ? (
                <Link href={def.link(i)} underline="hover" noWrap sx={{ flex: 1, minWidth: 0 }} title={i.name}>
                  {i.name}
                </Link>
              ) : (
                <Typography noWrap sx={{ flex: 1, minWidth: 0 }} title={i.name}>
                  {i.name}
                </Typography>
              )}
              <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
                {formatBytes(i.size)}
              </Typography>
            </Stack>
          ))
        )}
      </Box>
      <Button variant="outlined" startIcon={busy ? <CircularProgress size={14} /> : <CleaningServicesOutlinedIcon />} disabled={!canClean || busy} onClick={onClean} sx={{ alignSelf: "flex-start" }}>
        {def.cleanLabel}
      </Button>
    </Paper>
  );
}

export function DiskUsageView() {
  // docker system df is slow on big engines: refresh on changes, but debounced generously.
  const { data, error, loading, reload } = useResource<DiskUsage>("/system/df", ["image", "container", "volume"], 3000);
  const { toast, confirm } = useFeedback();
  const [busy, setBusy] = useState<Kind | null>(null);

  const clean = async (def: (typeof CATEGORIES)[number]) => {
    const ok = await confirm({ title: `${def.cleanLabel}?`, message: def.confirm, confirmLabel: "Clean up", destructive: true });
    if (!ok) return;
    setBusy(def.kind);
    try {
      const r = await api.post<{ deleted: number; spaceReclaimed: number }>(`/system/prune/${def.kind}`);
      toast("success", `${def.label}: ${r.deleted} removed, ${formatBytes(r.spaceReclaimed)} reclaimed`);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  return (
    <>
      <PageHeader
        title="Disk usage"
        subtitle="What takes space in the engine, and what can be cleaned up."
        actions={
          <Button variant="outlined" startIcon={loading ? <CircularProgress size={14} /> : <RefreshIcon />} onClick={() => void reload()} disabled={loading}>
            Refresh
          </Button>
        }
      />
      {error && !data ? (
        <EmptyState title="Couldn't load disk usage">
          <Typography>{error}</Typography>
        </EmptyState>
      ) : !data ? (
        <Stack alignItems="center" spacing={1.5} sx={{ py: 8 }}>
          <CircularProgress size={26} />
          <Typography color="text.secondary">Measuring disk usage… this can take a while.</Typography>
        </Stack>
      ) : (
        <Box sx={{ overflow: "auto" }}>
          <UsageBar data={data} />
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 2 }}>
            {CATEGORIES.map((def) => (
              <CategoryCard key={def.kind} def={def} cat={data[def.kind]} busy={busy === def.kind} onClean={() => void clean(def)} />
            ))}
          </Box>
        </Box>
      )}
    </>
  );
}
