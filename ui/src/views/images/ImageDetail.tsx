import { useState } from "react";
import { Box, Button, Chip, CircularProgress, IconButton, Link, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, Tooltip, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import SearchOffIcon from "@mui/icons-material/SearchOff";
import { useResource } from "../../hooks/useResource";
import { href, navigate } from "../../hooks/useRoute";
import { CopyableId, EmptyState, StatusDot } from "../../components/common";
import { KeepAliveTabs } from "../../components/KeepAliveTabs";
import { JsonTree } from "../../components/JsonTree";
import { formatBytes, relativeTime } from "../../utils/format";
import { MONO } from "../../theme";
import type { ContainerState } from "../../api/types";
import { RunDialog } from "./RunDialog";
import { CopyToEngineDialog } from "./CopyToEngineDialog";
import MoveUpOutlinedIcon from "@mui/icons-material/MoveUpOutlined";
import { useImageActions } from "./ImagesView";
import type { ImageRow } from "./types";

interface Details {
  inspect: {
    Id: string;
    RepoTags: string[] | null;
    RepoDigests: string[] | null;
    Created: string;
    Size: number;
    Architecture: string;
    Os: string;
    Config: { Cmd: string[] | null; Entrypoint: string[] | null; ExposedPorts?: Record<string, unknown>; WorkingDir?: string; User?: string };
  };
  history: { Id: string; Created: number; CreatedBy: string; Size: number; Comment: string; Tags: string[] | null }[];
  containers: { id: string; name: string; state: string; project: string | null }[];
}

const TABS = [
  { key: "layers", label: "Layers" },
  { key: "tags", label: "Tags" },
  { key: "containers", label: "Containers" },
  { key: "inspect", label: "Inspect" },
];

function ClampedText({ text, lines = 3 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split("\n").length > lines;
  return (
    <Box
      onClick={() => long && setOpen((o) => !o)}
      title={long && !open ? "Click to expand" : undefined}
      sx={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        cursor: long ? "pointer" : "default",
        ...(open || !long ? {} : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }),
      }}
    >
      {text}
    </Box>
  );
}

/** Strip the Dockerfile noise from history commands. */
function prettyCmd(cmd: string): string {
  return cmd
    .replace(/^RUN \/bin\/sh -c /, "RUN ")
    .replace(/^\/bin\/sh -c #\(nop\)\s*/, "")
    .replace(/^\/bin\/sh -c /, "RUN ")
    .replace(/^\|\d+ .*?\/bin\/sh -c /, "RUN ")
    .trim();
}

export function ImageDetail({ imageRef, tab }: { imageRef: string; tab?: string }) {
  const { data, error } = useResource<Details>(`/images/${encodeURIComponent(imageRef)}/details`, ["image", "container"]);
  const { remove } = useImageActions(() => undefined);
  const [runOpen, setRunOpen] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const active = TABS.some((t) => t.key === tab) ? tab! : "layers";

  if (error && !data) {
    return (
      <EmptyState icon={<SearchOffIcon sx={{ fontSize: 48 }} />} title="Image not found">
        <Typography sx={{ mb: 2 }}>{error}</Typography>
        <Button variant="contained" onClick={() => navigate("images")}>
          Back to images
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
  const img = data.inspect;
  const tags = img.RepoTags ?? [];
  const title = tags.includes(imageRef) ? imageRef : (tags[0] ?? img.Id.slice(7, 19));
  const deleteRow: ImageRow = {
    id: img.Id,
    ref: tags.includes(imageRef) ? imageRef : img.Id,
    repo: title,
    tag: "",
    created: 0,
    size: img.Size,
    inUse: data.containers.length > 0,
    containers: data.containers.length,
    digests: [],
    labels: {},
    dangling: !tags.length,
    isSystem: false,
  };
  const cmd = [...(img.Config.Entrypoint ?? []), ...(img.Config.Cmd ?? [])].join(" ");

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1.5} sx={{ mb: 1 }}>
        <IconButton onClick={() => navigate("images")} aria-label="Back" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <LayersOutlinedIcon sx={{ fontSize: 32, mt: 0.25, color: data.containers.length ? "success.main" : "text.disabled" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h2" noWrap>
            {title}
          </Typography>
          <Stack direction="row" spacing={2} sx={{ mt: 0.5, flexWrap: "wrap" }} alignItems="center" useFlexGap>
            <CopyableId id={img.Id} />
            <Typography variant="body2" color="text.secondary">
              {formatBytes(img.Size)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Created {relativeTime(img.Created)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {img.Os}/{img.Architecture}
            </Typography>
            {cmd && (
              <Typography variant="body2" color="text.secondary" sx={{ fontFamily: MONO }} noWrap>
                CMD {cmd}
              </Typography>
            )}
          </Stack>
        </Box>
        <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={() => setRunOpen(true)}>
          Run
        </Button>
        <Tooltip title="Copy to another engine">
          <IconButton onClick={() => setCopyOpen(true)} aria-label="Copy to another engine" sx={{ border: 1, borderColor: "divider", borderRadius: 1 }}>
            <MoveUpOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete image">
          <IconButton
            onClick={() => void remove([deleteRow]).then((ok) => ok && navigate("images"))}
            aria-label="Delete image"
            sx={{ border: 1, borderColor: "divider", borderRadius: 1, color: "error.main" }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Tabs value={active} onChange={(_, t) => navigate("images", imageRef, t)} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.key === "containers" ? `Containers (${data.containers.length})` : t.label} />
        ))}
      </Tabs>
      <KeepAliveTabs
        active={active}
        panels={{
          layers: () => (
            <Paper variant="outlined" sx={{ overflow: "auto", flex: "0 1 auto", minHeight: 0 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 40 }}>#</TableCell>
                    <TableCell>Instruction</TableCell>
                    <TableCell align="right" sx={{ width: 100 }}>
                      Size
                    </TableCell>
                    <TableCell sx={{ width: 130 }}>Created</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...data.history].reverse().map((h, i) => (
                    <TableRow key={i} hover>
                      <TableCell sx={{ color: "text.secondary" }}>{i + 1}</TableCell>
                      <TableCell sx={{ fontFamily: MONO, fontSize: 12 }}>
                        <ClampedText text={prettyCmd(h.CreatedBy)} />
                      </TableCell>
                      <TableCell align="right" sx={{ color: h.Size ? "text.primary" : "text.disabled" }}>
                        {formatBytes(h.Size)}
                      </TableCell>
                      <TableCell>{relativeTime(h.Created)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          ),
          tags: () => (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="h5" gutterBottom>
                Tags
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
                {tags.length ? tags.map((t) => <Chip key={t} label={t} size="small" sx={{ fontFamily: MONO }} />) : <Typography color="text.secondary">Untagged</Typography>}
              </Stack>
              <Typography variant="h5" gutterBottom>
                Digests
              </Typography>
              {(img.RepoDigests ?? []).length ? (
                (img.RepoDigests ?? []).map((d) => (
                  <Typography key={d} sx={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>
                    {d}
                  </Typography>
                ))
              ) : (
                <Typography color="text.secondary">No registry digest (built or loaded locally)</Typography>
              )}
            </Paper>
          ),
          containers: () =>
            data.containers.length === 0 ? (
              <EmptyState title="No containers use this image" />
            ) : (
              <Paper variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Container</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Project</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.containers.map((c) => (
                      <TableRow key={c.id} hover>
                        <TableCell>
                          <Link href={href("containers", c.id)} underline="hover" sx={{ fontWeight: 500 }}>
                            {c.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <StatusDot state={c.state as ContainerState} size={8} />
                            <span style={{ textTransform: "capitalize" }}>{c.state}</span>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          {c.project ? (
                            <Link href={href("projects", c.project)} underline="hover">
                              {c.project}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            ),
          inspect: () => <JsonTree data={img} />,
        }}
      />
      <RunDialog image={tags.includes(imageRef) ? imageRef : img.Id} open={runOpen} onClose={() => setRunOpen(false)} />
      <CopyToEngineDialog image={tags.includes(imageRef) ? imageRef : (tags[0] ?? img.Id)} open={copyOpen} onClose={() => setCopyOpen(false)} />
    </Box>
  );
}
