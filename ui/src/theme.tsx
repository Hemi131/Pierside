/**
 * Theme provider. `@docker/docker-mui-theme` only reads options that Docker Desktop injects
 * (`window.__ddMuiV5Themes`); Rancher doesn't inject them. So we use them when present and
 * otherwise fall back to our own Docker Desktop–like light/dark theme.
 */
import { ReactNode, useMemo } from "react";
import { createTheme, ThemeOptions, ThemeProvider, useMediaQuery } from "@mui/material";

type Bag = { light: ThemeOptions; dark: ThemeOptions };

const FONT = `"Roboto", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`;
export const MONO = `"Roboto Mono", "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace`;

function options(mode: "light" | "dark"): ThemeOptions {
  const dark = mode === "dark";
  return {
    palette: {
      mode,
      primary: { main: dark ? "#3d8bff" : "#0a63ed", contrastText: "#fff" },
      secondary: { main: dark ? "#9aa7b4" : "#505f6e" },
      success: { main: dark ? "#3fb950" : "#1a7f37" },
      warning: { main: dark ? "#d29922" : "#bf8700" },
      error: { main: dark ? "#f85149" : "#cf222e" },
      info: { main: dark ? "#58a6ff" : "#0969da" },
      background: dark ? { default: "#1b1f24", paper: "#22272e" } : { default: "#f4f5f7", paper: "#ffffff" },
      text: dark
        ? { primary: "#e6edf3", secondary: "#9aa7b4", disabled: "#5c6772" }
        : { primary: "#17202a", secondary: "#56626e", disabled: "#9aa3ad" },
      divider: dark ? "#353c45" : "#e1e4e8",
      action: dark ? { hover: "rgba(255,255,255,0.06)", selected: "rgba(61,139,255,0.16)" } : { hover: "rgba(10,99,237,0.05)", selected: "rgba(10,99,237,0.10)" },
    },
    shape: { borderRadius: 4 },
    typography: {
      fontFamily: FONT,
      fontSize: 13,
      h1: { fontSize: 24, fontWeight: 500 },
      h2: { fontSize: 20, fontWeight: 500 },
      h3: { fontSize: 18, fontWeight: 500 },
      h4: { fontSize: 16, fontWeight: 500 },
      h5: { fontSize: 14, fontWeight: 500 },
      h6: { fontSize: 13, fontWeight: 600 },
      body1: { fontSize: 13 },
      body2: { fontSize: 12 },
      button: { textTransform: "none", fontWeight: 500 },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true, size: "small" },
        styleOverrides: { root: { borderRadius: 4, paddingLeft: 12, paddingRight: 12 } },
      },
      MuiIconButton: { defaultProps: { size: "small" } },
      MuiTextField: { defaultProps: { size: "small" } },
      MuiTooltip: { defaultProps: { arrow: true, disableInteractive: true } },
      MuiTableCell: {
        styleOverrides: {
          root: { borderBottomColor: dark ? "#2f353d" : "#eaecef", paddingTop: 6, paddingBottom: 6 },
          head: { fontWeight: 500, color: dark ? "#9aa7b4" : "#56626e", whiteSpace: "nowrap" },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
      MuiTab: { styleOverrides: { root: { textTransform: "none", minHeight: 40, fontWeight: 500 } } },
      MuiTabs: { styleOverrides: { root: { minHeight: 40 } } },
      MuiCssBaseline: {
        styleOverrides: {
          "*::-webkit-scrollbar": { width: 10, height: 10 },
          "*::-webkit-scrollbar-thumb": { backgroundColor: dark ? "#3a424c" : "#c9ced4", borderRadius: 5, border: "2px solid transparent", backgroundClip: "content-box" },
          "*::-webkit-scrollbar-corner": { background: "transparent" },
        },
      },
    },
  };
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)", { noSsr: true });
  const theme = useMemo(() => {
    const injected = (window as unknown as { __ddMuiV5Themes?: Bag }).__ddMuiV5Themes;
    const mode = prefersDark ? "dark" : "light";
    return createTheme(injected?.[mode] ?? options(mode));
  }, [prefersDark]);
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
