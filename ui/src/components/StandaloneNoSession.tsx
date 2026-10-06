import { Box, Typography } from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import { EmptyState } from "./common";

/** Shown when the standalone window is opened without a valid (unused, unexpired) link. */
export function StandaloneNoSession() {
  return (
    <Box sx={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "background.default" }}>
      <EmptyState icon={<OpenInNewIcon sx={{ fontSize: 48 }} />} title="Open Pierside from Rancher Desktop">
        <Typography variant="body1">
          This window needs a fresh link. In Rancher Desktop, open <b>Pierside</b> and click <b>Open in separate window</b> at the bottom of its sidebar.
          Links work once and expire after a minute.
        </Typography>
      </EmptyState>
    </Box>
  );
}
