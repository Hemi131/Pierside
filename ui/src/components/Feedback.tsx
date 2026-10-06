/** Toasts (in-app snackbars — Rancher's ddClient toasts are OS notifications) and confirm dialogs. */
import { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
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
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const toast = useCallback((severity: Severity, message: string) => {
    setQueue((q) => [...q, { id: nextId.current++, severity, message }]);
    setOpen(true);
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })),
    [],
  );

  const close = (v: boolean) => {
    dialog?.resolve(v);
    setDialog(null);
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
      <Dialog open={!!dialog} onClose={() => close(false)} maxWidth="xs" fullWidth>
        {dialog && (
          <>
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
          </>
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
