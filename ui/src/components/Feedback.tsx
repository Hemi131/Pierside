/** Toasts (in-app snackbars — Rancher's ddClient toasts are OS notifications) and confirm dialogs. */
import { createContext, Fragment, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Snackbar } from "@mui/material";

type Severity = "success" | "info" | "warning" | "error";
interface Toast {
  id: number;
  severity: Severity;
  message: string;
}

interface ConfirmOptions {
  title: string;
  message: ReactNode;
  /** Shown as a highlighted warning under the message (e.g. the target belongs to Rancher Desktop). */
  warning?: string;
  confirmLabel?: string;
  destructive?: boolean;
}

interface FeedbackCtx {
  toast: (severity: Severity, message: string) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const Ctx = createContext<FeedbackCtx | null>(null);

/** Warnings for deleting something that belongs to Rancher Desktop itself or to one of its extensions. */
export const RANCHER_WARNING = {
  system: "This is part of Rancher Desktop's own setup (Kubernetes). Deleting it can break Rancher Desktop or its cluster.",
  extension: "This belongs to a Rancher Desktop extension (Pierside itself is one). Deleting it can break that extension or erase its saved data, such as Pierside's engines and SSH keys.",
};

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Toast[]>([]);
  const [open, setOpen] = useState(true);
  const nextId = useRef(1);
  // Questions wait their turn: one shown at a time, each answered in order (a second confirm used to
  // replace the first, whose promise then never resolved).
  const [dialogs, setDialogs] = useState<(ConfirmOptions & { id: number; resolve: (v: boolean) => void })[]>([]);
  const dialog = dialogs[0] ?? null;

  const toast = useCallback((severity: Severity, message: string) => {
    setQueue((q) => [...q, { id: nextId.current++, severity, message }]);
    setOpen(true);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        const id = nextId.current++;
        setDialogs((d) => [...d, { ...opts, id, resolve }]);
      }),
    [],
  );

  // When a question appeared: a click or a held Enter meant for the one before mustn't confirm it.
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = Date.now();
  }, [dialog]);

  const close = (v: boolean) => {
    if (v && Date.now() - shownAt.current < 400) return;
    dialog?.resolve(v);
    setDialogs((d) => d.slice(1));
  };

  const current = queue[0];

  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <Snackbar
        key={current?.id}
        open={!!current && open}
        autoHideDuration={current?.severity === "error" ? 8000 : 4000}
        onClose={(_, reason) => reason !== "clickaway" && setOpen(false)}
        TransitionProps={{
          // Next queued toast: it needs `open` again (it was cleared to close the previous one).
          onExited: () => {
            setQueue((q) => q.slice(1));
            setOpen(true);
          },
        }}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        sx={{ mb: 4 }}
      >
        {current ? (
          <Alert severity={current.severity} variant="filled" onClose={() => setOpen(false)} sx={{ maxWidth: 560, wordBreak: "break-word" }}>
            {current.message}
          </Alert>
        ) : undefined}
      </Snackbar>
      <Dialog
        open={!!dialog}
        onClose={() => close(false)}
        maxWidth="xs"
        fullWidth
        // A held Enter repeats: only a fresh press may answer (or it would confirm the next question too).
        onKeyDownCapture={(e) => {
          if (e.key === "Enter" && e.repeat) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {dialog && (
          // Keyed per question: its buttons are new elements, not the previous question's.
          <Fragment key={dialog.id}>
            <DialogTitle>{dialog.title}</DialogTitle>
            <DialogContent>
              <DialogContentText component="div">{dialog.message}</DialogContentText>
              {dialog.warning && (
                <Alert severity="warning" sx={{ mt: 2 }}>
                  {dialog.warning}
                </Alert>
              )}
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 2 }}>
              <Button variant="outlined" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant="contained" color={dialog.destructive ? "error" : "primary"} onClick={() => close(true)} autoFocus>
                {dialog.confirmLabel ?? "Confirm"}
              </Button>
            </DialogActions>
          </Fragment>
        )}
      </Dialog>
    </Ctx.Provider>
  );
}

export function useFeedback(): FeedbackCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFeedback outside FeedbackProvider");
  return ctx;
}
