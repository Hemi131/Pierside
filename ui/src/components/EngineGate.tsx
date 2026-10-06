import { ReactNode } from "react";
import { Box, Button, CircularProgress, Stack, Typography } from "@mui/material";
import { navigate } from "../hooks/useRoute";
import { activateEngine } from "../views/engines/engineApi";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { useEngine } from "../hooks/useEngine";
import { EmptyState } from "./common";

/** Shows a clear message when the moby/dockerd engine isn't reachable (e.g. containerd selected). */
export function EngineGate({ children }: { children: ReactNode }) {
  const { engine, containers } = useEngine();
  if (engine && !engine.ok && containers === null && engine.engine?.type === "ssh") {
    return (
      <EmptyState icon={<ErrorOutlineIcon color="error" sx={{ fontSize: 48 }} />} title={`Can't reach ${engine.engine.name}`}>
        <Typography variant="body1" sx={{ mb: 1 }}>
          The remote engine ({engine.engine.target}) isn't reachable right now. Pierside keeps retrying.
        </Typography>
        <Typography variant="body2" sx={{ fontFamily: "monospace", color: "text.disabled", mb: 2 }}>
          {engine.error}
        </Typography>
        <Stack direction="row" spacing={1} justifyContent="center">
          <Button variant="contained" onClick={() => void activateEngine("local").catch((e) => window.alert((e as Error).message))}>
            Switch to local engine
          </Button>
          <Button variant="outlined" onClick={() => navigate("engines")}>
            Manage engines
          </Button>
        </Stack>
      </EmptyState>
    );
  }
  if (engine && !engine.ok && containers === null) {
    return (
      <EmptyState icon={<ErrorOutlineIcon color="error" sx={{ fontSize: 48 }} />} title="Docker engine not available">
        <Typography variant="body1" sx={{ mb: 1 }}>
          Pierside needs Rancher Desktop's <b>dockerd (moby)</b> container engine. If you're using containerd, switch it in{" "}
          <b>Preferences → Container Engine</b>, apply, and reopen this tab.
        </Typography>
        <Typography variant="body2" sx={{ fontFamily: "monospace", color: "text.disabled" }}>
          {engine.error}
        </Typography>
      </EmptyState>
    );
  }
  if (containers === null) {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, py: 10 }}>
        <CircularProgress size={28} />
        <Box sx={{ mt: 2 }}>
          <Typography color="text.secondary">Connecting to the engine…</Typography>
        </Box>
      </Stack>
    );
  }
  return <>{children}</>;
}
