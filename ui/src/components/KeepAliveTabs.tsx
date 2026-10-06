import { ReactNode, useRef } from "react";
import { Box } from "@mui/material";

/**
 * Renders tab panels lazily and keeps them mounted after first visit (hidden when inactive),
 * so live sessions (logs, shell) survive tab switches.
 */
export function KeepAliveTabs({ active, panels }: { active: string; panels: Record<string, (visible: boolean) => ReactNode> }) {
  const visited = useRef(new Set<string>());
  visited.current.add(active);
  return (
    <>
      {Object.entries(panels).map(([key, render]) =>
        visited.current.has(key) ? (
          <Box key={key} sx={{ display: key === active ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
            {render(key === active)}
          </Box>
        ) : null,
      )}
    </>
  );
}
