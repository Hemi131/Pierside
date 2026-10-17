/**
 * Files on the active SSH engine's server: browsed and edited with the SSH user's rights, or through
 * a helper container where those rights aren't enough and the user agreed to that for this server
 * (backend services/hostfs.py). The file browser is the same one containers and volumes use.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Switch, Tooltip, Typography } from "@mui/material";
import ViewInArOutlinedIcon from "@mui/icons-material/ViewInArOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import { api, ApiError } from "../../api/ddclient";
import { FileBrowser, FileBrowserApi } from "../../components/FileBrowser";
import { PageHeader } from "../../components/common";
import { useFeedback } from "../../components/Feedback";
import { useEngine } from "../../hooks/useEngine";
import { MONO } from "../../theme";

interface State {
  engine: string;
  user: string;
  home: string;
  /** Use Docker where the SSH user has no permission; null = not asked yet. */
  useDocker: boolean | null;
  /** Why Docker can't help on this server (rootless, userns-remap), or null. */
  dockerProblem: string | null;
}

interface Question {
  path: string;
  user: string;
  answer: (allow: boolean) => void;
}

const q = (p: string) => encodeURIComponent(p);

export function ServerFilesView({ path }: { path?: string }) {
  const { engine } = useEngine();
  const { toast } = useFeedback();
  const meta = engine?.engine;
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [via, setVia] = useState<"ssh" | "docker" | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const asking = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    setState(null);
    setError(null);
    setVia(null);
    if (meta?.type !== "ssh") return;
    api
      .get<State>("/hostfs")
      .then(setState)
      .catch((e) => setError((e as Error).message));
  }, [meta?.id, meta?.type]);

  const setUseDocker = async (allow: boolean) => {
    try {
      await api.put("/hostfs/consent", { allow });
      setState((s) => (s ? { ...s, useDocker: allow } : s));
      return true;
    } catch (e) {
      toast("error", (e as Error).message);
      return false;
    }
  };

  const fs = useMemo<FileBrowserApi>(
    () => ({
      list: (p) => `/hostfs/files?path=${q(p)}`,
      preview: (p) => `/hostfs/file?path=${q(p)}`,
      download: (p) => `/hostfs/download?path=${q(p)}`,
      search: (p, text) => `/hostfs/search?path=${q(p)}&q=${q(text)}`,
      write: {
        upload: (dir, file) => `/hostfs/upload?path=${q(dir)}&filename=${q(file)}`,
        save: "/hostfs/file",
        mkdir: "/hostfs/mkdir",
        remove: "/hostfs/delete",
        chmod: "/hostfs/chmod",
      },
      onResult: (r) => {
        if (r && typeof r === "object" && "via" in r) setVia((r as { via: "ssh" | "docker" }).via);
      },
      // SSH was denied and nobody has decided yet whether Docker may be used on this server: ask once.
      onDenied: async (e) => {
        const detail = e instanceof ApiError ? (e.detail as { needsConsent?: boolean; path?: string; user?: string } | undefined) : undefined;
        if (!detail?.needsConsent) return false;
        // Several requests can be denied at once: they all wait for the one question (a second one
        // used to replace the first, whose answer then never came).
        asking.current ??= new Promise<boolean>((answer) => setQuestion({ path: detail.path ?? "", user: detail.user ?? "", answer })).then(async (allow) => {
          setQuestion(null);
          const ok = (await setUseDocker(allow)) && allow;
          asking.current = null;
          return ok;
        });
        return asking.current;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta?.id],
  );

  if (meta?.type !== "ssh") {
    return (
      <>
        <PageHeader title="Server files" />
        <Alert severity="info">Server files are for SSH engines. Switch to one with the engine menu at the top left.</Alert>
      </>
    );
  }

  const badge =
    via === "docker" ? (
      <Tooltip
        title={`You (${state?.user}) have no permission for this. Pierside works on it through a helper container on the server, as root. Files you save keep their owner and permissions; new ones get the owner of their folder.`}
      >
        <Chip size="small" color="warning" variant="outlined" icon={<ViewInArOutlinedIcon />} label="Through Docker (root)" sx={{ ml: 1 }} />
      </Tooltip>
    ) : via === "ssh" ? (
      <Tooltip title="With your own rights on the server, over SSH">
        <Chip size="small" variant="outlined" icon={<PersonOutlineIcon />} label={`As ${state?.user}`} sx={{ ml: 1 }} />
      </Tooltip>
    ) : null;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title="Server files"
        subtitle={
          <>
            Files on <Box component="span" sx={{ fontFamily: MONO }}>{meta.target}</Box>, with your SSH user's rights.
          </>
        }
        actions={
          state && (
            <Tooltip title={state.dockerProblem ?? "Where your SSH user has no permission, read and change files through a helper container on the server (as root). Your account can do this because it may use Docker there."}>
              <span>
                <FormControlLabel
                  control={<Switch size="small" checked={state.useDocker === true} disabled={!!state.dockerProblem} onChange={(e) => void setUseDocker(e.target.checked)} />}
                  label="Use Docker where I have no permission"
                />
              </span>
            </Tooltip>
          )
        }
      />
      {error && <Alert severity="error">{error}</Alert>}
      {!state && !error && <CircularProgress size={24} />}
      {state && <FileBrowser key={state.engine} fs={fs} start={path || state.home} goTo toolbar={badge} />}

      <Dialog open={!!question} maxWidth="sm" fullWidth>
        <DialogTitle>Use Docker for files you can't access?</DialogTitle>
        <DialogContent>
          <Typography>
            Your SSH user <b>{question?.user}</b> has no permission for <Box component="span" sx={{ fontFamily: MONO }}>{question?.path}</Box>.
          </Typography>
          <Typography sx={{ mt: 1.5 }}>
            Because your account may use Docker on this server, Pierside can read and change such files through a short-lived helper container that mounts the folder, as root.
            Files you save keep their owner and permissions. You'll see a badge whenever this happens.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Pierside remembers your answer for this server; you can change it with the switch at the top of the page. Check that working this way is fine where you work.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => question?.answer(false)}>Don't use Docker</Button>
          <Button variant="contained" onClick={() => question?.answer(true)}>
            Use Docker on this server
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
