/**
 * AppConfigured -- Authentication gate and theme bootstrap for the ABE app.
 *
 * This component controls the entire initialization sequence before the
 * main `<App />` tree is rendered:
 *
 *  1. **Fetch runtime config** -- loads `/aws-exports.json` (written at
 *     deploy time by CDK) to obtain Cognito pool IDs, API endpoints, and
 *     feature flags.
 *  2. **Configure Amplify** -- passes the config to `Amplify.configure()`,
 *     which wires up Auth, API, and Storage clients globally.
 *  3. **Check authentication** -- calls `Auth.currentAuthenticatedUser()`.
 *     If the user has a valid session the app renders immediately;
 *     otherwise a federated sign-in redirect is triggered (either to a
 *     custom OIDC provider or the default Cognito Hosted UI).
 *  4. **Theme detection** -- a `MutationObserver` watches for changes to
 *     the `--app-color-scheme` CSS variable on `<html>`. When it flips
 *     between `"dark"` and `"light"` (e.g. via OS preference or user
 *     toggle), the MUI theme is rebuilt so all downstream components
 *     re-render with the correct palette.
 *
 * While the config is loading or the auth redirect is in progress, the
 * component shows a centered spinner. If the config fetch fails entirely,
 * an error alert is displayed instead.
 */
import { useEffect, useState, useMemo } from "react";
import {
  ThemeProvider,
  defaultDarkModeOverride,
} from "@aws-amplify/ui-react";
import App from "../app";
import { Amplify, Auth } from "aws-amplify";
import { AppConfig } from "../common/types";
import { AppContext } from "../common/app-context";
import { StorageHelper, ThemeMode } from "../common/helpers/storage-helper";
import { ThemeProvider as MuiThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import { buildTheme } from "../common/theme";
import "@aws-amplify/ui-react/styles.css";

export default function AppConfigured() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<boolean | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean>(null!);
  const [theme, setTheme] = useState<ThemeMode>(StorageHelper.getTheme());
  const [configured, setConfigured] = useState<boolean>(false);

  const muiTheme = useMemo(() => buildTheme(theme), [theme]);

  /**
   * Initialization effect -- runs once on mount.
   *
   * Sequence:
   *  1. Fetch `/aws-exports.json` (Cognito, API Gateway, feature flags).
   *  2. Call `Amplify.configure()` so Auth/API clients are ready.
   *  3. Attempt `Auth.currentAuthenticatedUser()`.
   *     - Success: mark authenticated, store config, render the app.
   *     - Failure (no session): redirect to federated sign-in.
   *       Uses a custom OIDC provider when `federatedSignInProvider` is
   *       set; otherwise falls back to the default Cognito Hosted UI.
   *  4. If both the auth check and the redirect fail (e.g. network
   *     error), display the error state.
   */
  useEffect(() => {
    (async () => {
      let currentConfig: AppConfig;
      try {
        const result = await fetch("/aws-exports.json");
        const awsExports = await result.json();
        currentConfig = Amplify.configure(awsExports) as AppConfig;
        const user = await Auth.currentAuthenticatedUser();
        if (user) {
          setAuthenticated(true);
        }
        setConfig(awsExports);
        setConfigured(true);
      } catch {
        try {
          if (currentConfig!.federatedSignInProvider != "") {
            Auth.federatedSignIn({ customProvider: currentConfig!.federatedSignInProvider });
          } else {
            Auth.federatedSignIn();
          }
        } catch (error) {
          setError(true);
        }
      }
    })();
  }, []);

  /**
   * Re-authentication guard -- if the config has loaded but the user is
   * not authenticated (e.g. token expired between effects), trigger the
   * federated sign-in redirect again.
   */
  useEffect(() => {
    if (!authenticated && configured) {
      if (config!.federatedSignInProvider != "") {
        Auth.federatedSignIn({ customProvider: config!.federatedSignInProvider });
      } else {
        Auth.federatedSignIn();
      }
    }
  }, [authenticated, configured]);

  /**
   * Theme detection via MutationObserver.
   *
   * Other parts of the app (or the Amplify Authenticator) may write
   * `--app-color-scheme: dark | light` onto `<html style="...">`. This
   * observer watches for attribute mutations on `document.documentElement`
   * and, when the CSS variable changes, updates React state so the MUI
   * theme is rebuilt and all components receive the new palette.
   *
   * The observer is re-created whenever `theme` changes so the closure
   * always compares against the latest value.
   */
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (
          mutation.type === "attributes" &&
          mutation.attributeName === "style"
        ) {
          const newValue =
            document.documentElement.style.getPropertyValue(
              "--app-color-scheme"
            );
          const mode: ThemeMode = newValue === "dark" ? "dark" : "light";
          if (mode !== theme) {
            setTheme(mode);
          }
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });

    return () => {
      observer.disconnect();
    };
  }, [theme]);

  if (!config) {
    if (error) {
      return (
        <MuiThemeProvider theme={muiTheme}>
          <CssBaseline />
          <Box
            sx={{
              height: "100%",
              width: "100%",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
            }}
          >
            <Alert severity="error" variant="filled">
              Error loading configuration from{" "}
              <a href="/aws-exports.json" style={{ fontWeight: 600, color: "inherit" }}>
                /aws-exports.json
              </a>
            </Alert>
          </Box>
        </MuiThemeProvider>
      );
    }

    return (
      <MuiThemeProvider theme={muiTheme}>
        <CssBaseline />
        <Box
          sx={{
            width: "100%",
            height: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 1,
          }}
        >
          <CircularProgress size={20} />
          Loading
        </Box>
      </MuiThemeProvider>
    );
  }

  return (
    <AppContext.Provider value={config}>
      <MuiThemeProvider theme={muiTheme}>
        <CssBaseline />
        <ThemeProvider
          theme={{
            name: "default-theme",
            overrides: [defaultDarkModeOverride],
          }}
          colorMode={theme === "dark" ? "dark" : "light"}
        >
          {authenticated ? <App /> : <></>}
        </ThemeProvider>
      </MuiThemeProvider>
    </AppContext.Provider>
  );
}
