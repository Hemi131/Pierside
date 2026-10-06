/** Footer version label, the "Update available" notice, and the About dialog with the update commands. */
import { useEffect, useState } from "react";
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, Link, Stack, Switch, Tooltip, Typography } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { api, openExternal } from "../api/ddclient";
import { copyText } from "../utils/format";
import { MONO } from "../theme";
import { useFeedback } from "./Feedback";

interface VersionInfo {
  version: string;
  /** A numbered release (dev and edge builds never check for updates). */
  release: boolean;
  check: boolean;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string;
  commands: string[];
  error: string | null;
}

const RECHECK_MS = 6 * 3600 * 1000; // the backend itself asks GitHub at most once a day

export function VersionFooter() {
  const { toast } = useFeedback();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const load = () =>
      api
        .get<VersionInfo>("/system/version")
        .then(setInfo)
        .catch(() => undefined); // older backend, or not reachable yet: just show the name
    load();
    const timer = window.setInterval(load, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const setCheck = (check: boolean) =>
    api
      .put<VersionInfo>("/system/version", { check })
      .then(setInfo)
      .catch((e) => toast("error", (e as Error).message));

  const commands = info?.commands.join("\n") ?? "";

  return (
    <>
      {info?.updateAvailable && (
        <Button size="small" color="primary" onClick={() => setOpen(true)} sx={{ minHeight: 0, py: 0.25 }}>
          Update available: {info.latest}
        </Button>
      )}
      <Tooltip title="About Pierside">
        <Link component="button" underline="hover" color="inherit" variant="body2" onClick={() => setOpen(true)}>
          Pierside{info ? ` ${info.version}` : ""}
        </Link>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Pierside {info?.version}</DialogTitle>
        <DialogContent>
          {info?.updateAvailable ? (
            <>
              <Typography>
                Version {info.latest} is available.{" "}
                <Link component="button" onClick={() => openExternal(info.releaseUrl)} sx={{ verticalAlign: "baseline" }}>
                  What's new
                </Link>
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                To update, run this in a terminal on this computer. Your engines, keys and settings are kept.
              </Typography>
              <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mt: 1, p: 1.5, borderRadius: 1, bgcolor: "action.hover" }}>
                <Box component="pre" sx={{ m: 0, flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12.5, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {commands}
                </Box>
                <Tooltip title="Copy">
                  <IconButton size="small" onClick={() => void copyText(commands).then(() => toast("success", "Commands copied"))} aria-label="Copy update commands">
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </>
          ) : info?.release ? (
            <Typography color="text.secondary">
              {!info.check ? "Update check is off." : info.error ? "Couldn't check for a newer version." : "You have the newest version."}
            </Typography>
          ) : (
            <Typography color="text.secondary">This is a development build; it doesn't check for updates.</Typography>
          )}
          {info?.release && info.check && info.error && !info.updateAvailable && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              {info.error}
            </Alert>
          )}
          {info?.release && (
            <FormControlLabel
              sx={{ mt: 2, alignItems: "flex-start" }}
              control={<Switch size="small" checked={info.check} onChange={(e) => void setCheck(e.target.checked)} sx={{ mt: 0.25 }} />}
              label={
                <>
                  <Typography>Check for new versions</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Once a day Pierside asks GitHub for the newest release number. Nothing about this installation is sent.
                  </Typography>
                </>
              }
            />
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            <Link component="button" onClick={() => openExternal("https://github.com/Hemi131/Pierside")} sx={{ verticalAlign: "baseline" }}>
              github.com/Hemi131/Pierside
            </Link>
            {" · Apache-2.0 · not affiliated with Docker, Inc. or SUSE"}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="outlined" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
