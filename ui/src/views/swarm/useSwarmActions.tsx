import { useCallback, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import { api } from "../../api/ddclient";
import { useFeedback } from "../../components/Feedback";
import type { SwarmService } from "./types";

const enc = encodeURIComponent;

export function useSwarmActions(reload: () => void) {
  const { toast, confirm } = useFeedback();

  const run = useCallback(
    async (fn: () => Promise<unknown>, ok: string) => {
      try {
        await fn();
        toast("success", ok);
        return true;
      } catch (e) {
        toast("error", (e as Error).message);
        return false;
      } finally {
        reload();
      }
    },
    [toast, reload],
  );

  const removeService = async (id: string, name: string) => {
    const yes = await confirm({ title: "Remove service?", message: `"${name}" and all its tasks will be removed.`, confirmLabel: "Remove", destructive: true });
    return yes && run(() => api.del(`/swarm/services/${enc(id)}`), `Service ${name} removed`);
  };

  return {
    scale: (s: SwarmService, replicas: number) => run(() => api.post(`/swarm/services/${s.id}/scale`, { replicas }), `Scaling ${s.name} to ${replicas}`),
    restart: async (s: SwarmService) => {
      const yes = await confirm({
        title: "Restart service?",
        message: `All tasks of "${s.name}" will be replaced one by one using its update policy (like docker service update --force).`,
        confirmLabel: "Restart",
      });
      return yes && run(() => api.post(`/swarm/services/${s.id}/restart`), `Restarting ${s.name}`);
    },
    rollback: async (s: SwarmService) => {
      const yes = await confirm({ title: "Roll back service?", message: `"${s.name}" will be reverted to its previous specification.`, confirmLabel: "Roll back" });
      return yes && run(() => api.post(`/swarm/services/${s.id}/rollback`), `Rolling back ${s.name}`);
    },
    remove: (s: Pick<SwarmService, "id" | "name">) => removeService(s.id, s.name),
    removeStack: async (name: string) => {
      const yes = await confirm({
        title: "Remove stack?",
        message: `All services of "${name}" will be removed, along with its networks, secrets and configs (like docker stack rm). Volumes are kept.`,
        confirmLabel: "Remove stack",
        destructive: true,
      });
      return yes && run(() => api.del(`/swarm/stacks/${enc(name)}`), `Stack ${name} removed`);
    },
  };
}

/** Small dialog to set the replica count. */
export function ScaleDialog({ service, onClose, onScale }: { service: SwarmService | null; onClose: () => void; onScale: (s: SwarmService, n: number) => void }) {
  const [value, setValue] = useState<number | null>(null);
  const current = value ?? service?.desired ?? 1;
  const close = () => {
    setValue(null);
    onClose();
  };
  return (
    <Dialog open={!!service} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Scale {service?.name}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Currently {service?.running ?? 0} running of {service?.desired ?? 0} desired.
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1} justifyContent="center">
          <IconButton onClick={() => setValue(Math.max(0, current - 1))} aria-label="Fewer replicas">
            <RemoveIcon />
          </IconButton>
          <TextField
            value={current}
            onChange={(e) => setValue(Math.max(0, Math.min(1000, parseInt(e.target.value.replace(/\D/g, "") || "0", 10))))}
            inputProps={{ style: { textAlign: "center", width: 60 }, "aria-label": "Replicas" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && service) {
                onScale(service, current);
                close();
              }
            }}
          />
          <IconButton onClick={() => setValue(current + 1)} aria-label="More replicas">
            <AddIcon />
          </IconButton>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            if (service) onScale(service, current);
            close();
          }}
        >
          Scale
        </Button>
      </DialogActions>
    </Dialog>
  );
}
