import { useMemo } from "react";
import { Alert, Box, Button, CircularProgress, IconButton, Link, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Tooltip, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import { useResource } from "../../hooks/useResource";
import { href, navigate } from "../../hooks/useRoute";
import { EmptyState, StatusDot } from "../../components/common";
import { KeepAliveTabs } from "../../components/KeepAliveTabs";
import { JsonTree } from "../../components/JsonTree";
import { FileBrowser, volumeFsApi } from "../../components/FileBrowser";
import { formatBytes, relativeTime } from "../../utils/format";
import type { ContainerState } from "../../api/types";
import type { Volume } from "./types";
import { useVolumeActions } from "./VolumesView";

const TABS = [
  { key: "data", label: "Stored data" },
  { key: "containers", label: "Containers in use" },
  { key: "inspect", label: "Inspect" },
];

export function VolumeDetail({ name, tab }: { name: string; tab?: string }) {
  const { data, error, reload } = useResource<{ volume: Volume; inspect: unknown }>(`/volumes/${encodeURIComponent(name)}`, ["volume", "container"]);
  const sizes = useResource<Record<string, number>>("/volumes/sizes", []);
  const { remove } = useVolumeActions(() => void reload());
  const fs = useMemo(() => volumeFsApi(name), [name]);
  const active = TABS.some((t) => t.key === tab) ? tab! : "data";

  if (error && !data) {
    return (
      <EmptyState icon={<SearchOffIcon sx={{ fontSize: 48 }} />} title="Volume not found">
        <Typography sx={{ mb: 2 }}>{error}</Typography>
        <Button variant="contained" onClick={() => navigate("volumes")}>
          Back to volumes
        </Button>
      </EmptyState>
    );
  }
  if (!data) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress size={26} />
      </Stack>
    );
  }
  const v = data.volume;
  const size = sizes.data?.[v.name];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 1 }}>
        <IconButton onClick={() => navigate("volumes")} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <StorageOutlinedIcon sx={{ fontSize: 32, mt: 0.25, color: v.inUse ? "success.main" : "text.disabled" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h2" noWrap title={v.name}>
            {v.name}
          </Typography>
          <Stack direction="row" spacing={2} sx={{ mt: 0.5 }} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              {v.inUse ? `In use by ${v.containers.length} container${v.containers.length === 1 ? "" : "s"}` : "Unused"}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Created {relativeTime(v.createdAt)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Size {size === undefined ? "…" : size < 0 ? "N/A" : formatBytes(size)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Driver {v.driver}
            </Typography>
          </Stack>
        </Box>
        <Tooltip title={v.inUse ? "In use by a container" : "Delete volume"}>
          <span>
            <IconButton
              disabled={v.inUse}
              onClick={() => void remove([v.name]).then((ok) => ok && navigate("volumes"))}
              aria-label="Delete volume"
              sx={{ border: 1, borderColor: "divider", borderRadius: 1, color: "error.main" }}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Tabs value={active} onChange={(_, t) => navigate("volumes", name, t)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>
      <KeepAliveTabs
        active={active}
        panels={{
          data: () => (
            <>
              <Alert severity="info" sx={{ mb: 1, py: 0 }}>
                Changes are written straight into the volume, so containers using it see them immediately. Browsing uses a read-only helper container; changes use a separate writable one. Both are removed when you stop.
              </Alert>
              <FileBrowser fs={fs} emptyHint="This volume is empty." />
            </>
          ),
          containers: () =>
            v.containers.length === 0 ? (
              <EmptyState title="No containers use this volume" />
            ) : (
              <Paper variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Container</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Mounted at</TableCell>
                      <TableCell>Mode</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {v.containers.map((c) => (
                      <TableRow key={c.id} hover>
                        <TableCell>
                          <Link href={href("containers", c.id)} underline="hover" sx={{ fontWeight: 500 }}>
                            {c.name}
                          </Link>
                          {c.project && (
                            <Typography variant="body2" color="text.secondary">
                              Project {c.project}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <StatusDot state={c.state as ContainerState} size={8} />
                            <span style={{ textTransform: "capitalize" }}>{c.state}</span>
                          </Stack>
                        </TableCell>
                        <TableCell sx={{ fontFamily: "monospace" }}>{c.destination}</TableCell>
                        <TableCell>{c.rw ? "Read / write" : "Read only"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            ),
          inspect: () => <JsonTree data={data.inspect} />,
        }}
      />
    </Box>
  );
}
