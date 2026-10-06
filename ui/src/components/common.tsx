import { ReactNode, useState } from "react";
import { Box, IconButton, InputAdornment, Link, Stack, TextField, Tooltip, Typography } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { ContainerState, Port } from "../api/types";
import { openExternal } from "../api/ddclient";
import { usePortHost } from "../hooks/useEngine";
import { copyText, shortId } from "../utils/format";
import { MONO } from "../theme";

export function stateColor(state: ContainerState | "partial" | undefined, health?: string | null): string {
  if (health === "unhealthy") return "error.main";
  switch (state) {
    case "running":
      return "success.main";
    case "partial":
    case "restarting":
    case "paused":
      return "warning.main";
    case "dead":
      return "error.main";
    default:
      return "text.disabled";
  }
}

export function StatusDot({ state, health, size = 10 }: { state: ContainerState | "partial"; health?: string | null; size?: number }) {
  return (
    <Box
      component="span"
      sx={{ display: "inline-block", width: size, height: size, borderRadius: "50%", bgcolor: stateColor(state, health), flexShrink: 0 }}
    />
  );
}

/** Short ID with click-to-copy of the full ID (Docker Desktop shows this under the name). */
export function CopyableId({ id, full = id }: { id: string; full?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip title={copied ? "Copied" : "Copy full ID"} onClose={() => setCopied(false)}>
      <Box
        component="span"
        onClick={(e) => {
          e.stopPropagation();
          void copyText(full).then(() => setCopied(true));
        }}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.5,
          fontFamily: MONO,
          fontSize: 11,
          color: "text.secondary",
          cursor: "pointer",
          "&:hover": { color: "text.primary" },
          "& svg": { opacity: 0 },
          "&:hover svg": { opacity: 1 },
        }}
      >
        {shortId(id)}
        <ContentCopyIcon sx={{ fontSize: 12 }} />
      </Box>
    </Tooltip>
  );
}

export function PortLinks({ ports, max = 2 }: { ports: Port[]; max?: number }) {
  const portHost = usePortHost();
  const published = ports.filter((p) => p.public);
  if (published.length === 0) return null;
  const shown = published.slice(0, max);
  const rest = published.length - shown.length;
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      {shown.map((p) => (
        <Link
          key={`${p.public}-${p.private}-${p.type}`}
          component="button"
          underline="hover"
          onClick={(e) => {
            e.stopPropagation();
            openExternal(`http://${portHost}:${p.public}`);
          }}
          sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, fontSize: 13 }}
        >
          {p.public}:{p.private}
          {p.type !== "tcp" && `/${p.type}`}
          <OpenInNewIcon sx={{ fontSize: 13 }} />
        </Link>
      ))}
      {rest > 0 && (
        <Tooltip title={published.slice(max).map((p) => `${p.public}:${p.private}/${p.type}`).join(", ")}>
          <Typography variant="body2" color="text.secondary" component="span">
            +{rest} more
          </Typography>
        </Tooltip>
      )}
    </Stack>
  );
}

export function SearchField({ value, onChange, placeholder = "Search" }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <TextField
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      sx={{ width: 320 }}
      inputProps={{ "data-search": true }}
      InputProps={{
        startAdornment: (
          <InputAdornment position="start">
            <SearchIcon fontSize="small" />
          </InputAdornment>
        ),
        endAdornment: value ? (
          <InputAdornment position="end">
            <IconButton onClick={() => onChange("")} edge="end" aria-label="Clear search">
              <ClearIcon fontSize="small" />
            </IconButton>
          </InputAdornment>
        ) : undefined,
      }}
    />
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ py: 10, color: "text.secondary", textAlign: "center" }}>
      {icon}
      <Typography variant="h4" color="text.primary">
        {title}
      </Typography>
      {children && <Box sx={{ maxWidth: 460 }}>{children}</Box>}
    </Stack>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" sx={{ mb: 2 }}>
      <Box>
        <Typography variant="h2">{title}</Typography>
        {subtitle && (
          <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions}
    </Stack>
  );
}
