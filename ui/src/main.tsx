import "./diagnostics";
import React from "react";
import ReactDOM from "react-dom/client";
import CssBaseline from "@mui/material/CssBaseline";
import GlobalStyles from "@mui/material/GlobalStyles";
import { AppThemeProvider } from "./theme";
import { EngineProvider } from "./hooks/useEngine";
import { FeedbackProvider } from "./components/Feedback";
import { initStandaloneSession, standalone } from "./api/ddclient";
import { StandaloneNoSession } from "./components/StandaloneNoSession";
import App from "./App";
import { loadWindowPrefs } from "./api/prefs";

async function start() {
  // Standalone window: redeem the one-time ticket before anything talks to the backend.
  const hasSession = standalone ? await initStandaloneSession().catch(() => false) : true;
  // Separate window: its view settings come from the backend; load them before the first render.
  if (standalone && hasSession) await loadWindowPrefs();
  if (standalone) document.title = "Pierside";

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppThemeProvider>
        <CssBaseline />
        {/* The UI fills the window and scrolls inside its own panes. A tooltip or menu that sticks out past
            the edge for a moment must not give the page a scrollbar, which shifts everything sideways. */}
        <GlobalStyles styles={{ "html, body": { overflow: "hidden" } }} />
        {hasSession ? (
          <FeedbackProvider>
            <EngineProvider>
              <App />
            </EngineProvider>
          </FeedbackProvider>
        ) : (
          <StandaloneNoSession />
        )}
      </AppThemeProvider>
    </React.StrictMode>,
  );
}

void start();
