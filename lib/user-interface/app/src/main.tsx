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

root.render(
  <React.StrictMode>
    <AppConfigured />
  </React.StrictMode>
);
