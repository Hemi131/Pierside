import { ReactNode } from "react";
import { Box, ButtonBase, Stack, Tooltip, Typography } from "@mui/material";
import BlockIcon from "@mui/icons-material/Block";
import CloudOutlinedIcon from "@mui/icons-material/CloudOutlined";
import ComputerIcon from "@mui/icons-material/Computer";
import { navigate } from "../hooks/useRoute";
import { useEngine } from "../hooks/useEngine";
import { isDefaultName } from "../views/engines/engineApi";

/** Engine colours: while an engine with a colour is active, the whole UI gets a frame + banner in it. */
export const ENGINE_COLORS = [
  { value: "#d32f2f", label: "Red (e.g. production)" },
  { value: "#ef6c00", label: "Orange" },
  { value: "#f9a825", label: "Yellow" },
  { value: "#2e7d32", label: "Green" },
  { value: "#1976d2", label: "Blue" },
  { value: "#7b1fa2", label: "Purple" },
  { value: "#616161", label: "Grey" },
];

/** Black or white, whichever reads better on `hex`. */
export function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#000" : "#fff";
}

function Swatch({ color, selected, label, onClick, children }: { color?: string; selected: boolean; label: string; onClick: () => void; children?: ReactNode }) {
  return (
    <Tooltip title={label}>
      <ButtonBase
        onClick={onClick}
        aria-label={label}
        aria-pressed={selected}
        sx={{
          width: 26,
          height: 26,
          borderRadius: "50%",
          bgcolor: color ?? "transparent",
          border: 1,
          borderColor: color ? "transparent" : "divider",
          color: "text.secondary",
          outline: selected ? 2 : 0,
          outlineColor: "text.primary",
          outlineOffset: 2,
          outlineStyle: "solid",
        }}
      >
        {children}
      </ButtonBase>
    </Tooltip>
  );
}

/** Preset swatches, "none", and a custom colour. */
export function EngineColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const custom = value && !ENGINE_COLORS.some((c) => c.value === value) ? value : "";
  return (
    <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
      <Swatch selected={!value} label="No colour" onClick={() => onChange("")}>
        <BlockIcon sx={{ fontSize: 16 }} />
      </Swatch>
      {ENGINE_COLORS.map((c) => (
        <Swatch key={c.value} color={c.value} selected={value === c.value} label={c.label} onClick={() => onChange(c.value)} />
      ))}
      <Tooltip title="Custom colour">
        <Box
          component="label"
          sx={{
            width: 26,
            height: 26,
            borderRadius: "50%",
            cursor: "pointer",
            background: custom || "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)",
            outline: custom ? 2 : 0,
            outlineColor: "text.primary",
            outlineOffset: 2,
            outlineStyle: "solid",
            position: "relative",
          }}
        >
          <input
            type="color"
            value={custom || "#d32f2f"}
            onChange={(e) => onChange(e.target.value)}
            style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }}
            aria-label="Custom colour"
          />
        </Box>
      </Tooltip>
    </Stack>
  );
}

/** Coloured frame + banner around the UI while the active engine has a colour. */
export function EngineFrame({ children }: { children: ReactNode }) {
  const { engine } = useEngine();
  const meta = engine?.engine;
  const color = meta?.color;
  const fg = color ? textOn(color) : undefined;
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh", ...(color && { bgcolor: color, p: "3px", pt: 0 }) }}>
      {meta && color && (
        <ButtonBase
          onClick={() => navigate("engines")}
          sx={{ height: 24, flexShrink: 0, justifyContent: "center", gap: 1, color: fg, fontSize: 12, fontWeight: 600, letterSpacing: 0.3 }}
          aria-label={`Active engine: ${meta.name}. Manage engines`}
        >
          {meta.type === "ssh" ? <CloudOutlinedIcon sx={{ fontSize: 15 }} /> : <ComputerIcon sx={{ fontSize: 15 }} />}
          {/* An engine without a name of its own is named after its address: show that once. */}
          {!isDefaultName(meta.name, meta.target) && <span>{meta.name}</span>}
          {meta.target && (
            <Typography component="span" sx={{ fontSize: 12, opacity: 0.85 }}>
              {meta.target}
            </Typography>
          )}
        </ButtonBase>
      )}
      <Box sx={{ flex: 1, minHeight: 0, ...(color && { borderRadius: "4px", overflow: "hidden" }) }}>{children}</Box>
    </Box>
  );
}
