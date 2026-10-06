import type { ITheme } from "@xterm/xterm";
import type { Theme } from "@mui/material";

export function xtermTheme(theme: Theme, background?: string): ITheme {
  const dark = theme.palette.mode === "dark";
  const bg = background ?? theme.palette.background.paper;
  return dark
    ? {
        background: bg,
        foreground: "#d6dde5",
        cursor: "#d6dde5",
        selectionBackground: "#3d8bff55",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      }
    : {
        background: bg,
        foreground: "#1f2328",
        cursor: "#1f2328",
        selectionBackground: "#0a63ed33",
        black: "#24292f",
        red: "#cf222e",
        green: "#116329",
        yellow: "#9a6700",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#6e7781",
        brightBlack: "#57606a",
        brightRed: "#a40e26",
        brightGreen: "#1a7f37",
        brightYellow: "#7d4e00",
        brightBlue: "#218bff",
        brightMagenta: "#a475f9",
        brightCyan: "#3192aa",
        brightWhite: "#8c959f",
      };
}
