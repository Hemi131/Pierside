/** Change the permission bits of a file or folder (chmod): a read/write/execute grid plus the octal value. */
import { useEffect, useState } from "react";
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, TextField, Typography } from "@mui/material";
import { MONO } from "../theme";

/** "-rwxr-sr-t" (ls style) -> "3755"-like octal, with the leading digit only when special bits are set. */
export function modeToOctal(mode: string): string {
  const m = mode.slice(-9).padStart(9, "-");
  let bits = 0;
  let special = 0;
  for (let i = 0; i < 9; i++) {
    const ch = m[i];
    const exec = i % 3 === 2;
    if (exec ? "xst".includes(ch) : ch !== "-") bits |= 1 << (8 - i);
    if (exec && "sStT".includes(ch)) special |= 4 >> Math.floor(i / 3);
  }
  const text = bits.toString(8).padStart(3, "0");
  return special ? `${special}${text}` : text;
}

const WHO = ["Owner", "Group", "Others"];
const WHAT = ["Read", "Write", "Execute"];

export interface PermissionsTarget {
  path: string;
  mode: string; // ls-style string
  owner: string;
  isDir: boolean;
}

export function PermissionsDialog({
  target,
  onClose,
}: {
  target: PermissionsTarget | null;
  onClose: (change: { mode: string; recursive: boolean } | null) => void;
}) {
  const [octal, setOctal] = useState("644");
  const [recursive, setRecursive] = useState(false);
  useEffect(() => {
    if (target) setOctal(modeToOctal(target.mode));
    setRecursive(false);
  }, [target]);

  const valid = /^[0-7]{3,4}$/.test(octal);
  const bits = valid ? parseInt(octal.slice(-3), 8) : 0;
  const special = octal.length === 4 ? octal[0] : "";
  const toggle = (bit: number) => setOctal((special === "0" ? "" : special) + (bits ^ bit).toString(8).padStart(3, "0"));
  const submit = () => valid && onClose({ mode: octal, recursive });

  return (
    <Dialog open={!!target} onClose={() => onClose(null)} maxWidth="xs" fullWidth>
      <DialogTitle>Permissions</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontFamily: MONO, fontSize: 13, wordBreak: "break-all" }}>{target?.path}</Typography>
        {target?.owner && (
          <Typography variant="body2" color="text.secondary">
            Owner: {target.owner}
          </Typography>
        )}
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr repeat(3, auto)", alignItems: "center", columnGap: 2, mt: 2 }}>
          <span />
          {WHAT.map((w) => (
            <Typography key={w} variant="body2" color="text.secondary" sx={{ textAlign: "center" }}>
              {w}
            </Typography>
          ))}
          {WHO.map((who, row) => [
            <Typography key={who}>{who}</Typography>,
            ...WHAT.map((what, col) => {
              const bit = 1 << (8 - (row * 3 + col));
              return (
                <Checkbox
                  key={who + what}
                  size="small"
                  disabled={!valid}
                  checked={(bits & bit) !== 0}
                  onChange={() => toggle(bit)}
                  inputProps={{ "aria-label": `${who} ${what.toLowerCase()}` }}
                  sx={{ justifySelf: "center" }}
                />
              );
            }),
          ])}
        </Box>
        <TextField
          label="Octal"
          value={octal}
          onChange={(e) => setOctal(e.target.value.trim())}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          error={!valid}
          helperText={valid ? " " : "3 or 4 digits from 0 to 7, like 644 or 0755"}
          size="small"
          sx={{ mt: 2, width: 140 }}
          InputProps={{ sx: { fontFamily: MONO } }}
        />
        {target?.isDir && (
          <FormControlLabel
            sx={{ display: "flex" }}
            control={<Checkbox size="small" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />}
            label="Also apply to everything inside this folder"
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="outlined" onClick={() => onClose(null)}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!valid} onClick={submit}>
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
