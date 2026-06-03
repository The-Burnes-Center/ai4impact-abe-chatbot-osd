import "regenerator-runtime/runtime";
import React from "react";
import ReactDOM from "react-dom/client";
import AppConfigured from "./components/app-configured";
import { StorageHelper } from "./common/helpers/storage-helper";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

const theme = StorageHelper.getTheme();
StorageHelper.applyTheme(theme);

if (import.meta.env.DEV) {
  // @axe-core/react streams accessibility violations to the browser console
  // while the app runs in dev mode. Production bundles never load axe.
  void import("@axe-core/react").then(({ default: axe }) => {
    axe(React, ReactDOM, 1000);
  });
}

if (import.meta.env.DEV && window.location.pathname.startsWith("/demo-animation")) {
  // Recording-only UI mockups (see scripts/record-demo.mjs), mounted BEFORE
  // AppConfigured so the headless recorder bypasses the Cognito auth gate.
  // Gated behind import.meta.env.DEV: in production this branch is dead code,
  // so Vite tree-shakes the route AND the entire demo bundle out — nothing
  // demo-related ships or is reachable. Rendered without StrictMode so the
  // looping useSteps() timers fire exactly once per step.
  void import("./demos/DemoGallery").then(({ default: DemoGallery }) => {
    root.render(<DemoGallery />);
  });
} else {
  root.render(
    <React.StrictMode>
      <AppConfigured />
    </React.StrictMode>
  );
}
