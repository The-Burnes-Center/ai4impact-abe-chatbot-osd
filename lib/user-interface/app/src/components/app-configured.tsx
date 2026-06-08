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
 *     otherwise the user is redirected to the Cognito Managed Login
 *     page, which offers both username/password (native Cognito users)
 *     and the federated "Sign in with Mass SSO" button.
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
import { Amplify, type ResourcesConfig } from "aws-amplify";
import { getCurrentUser, signInWithRedirect } from "aws-amplify/auth";
import { Hub } from "aws-amplify/utils";
import { AppConfig } from "../common/types";
import { Utils } from "../common/utils";
import { AppContext } from "../common/app-context";
import { StorageHelper, ThemeMode } from "../common/helpers/storage-helper";
import { ThemeProvider as MuiThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import CircularProgress from "@mui/material/CircularProgress";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import { buildTheme } from "../common/theme";
import "@aws-amplify/ui-react/styles.css";

/**
 * Map the v5-shaped `aws-exports.json` (still emitted by the CDK at deploy
 * time) onto the v6 `ResourcesConfig` that `Amplify.configure()` expects.
 * Keeping the on-disk contract stable means the backend/CDK is untouched.
 */
function toResourcesConfig(c: AppConfig): ResourcesConfig {
  return {
    Auth: {
      Cognito: {
        userPoolId: c.Auth.userPoolId,
        userPoolClientId: c.Auth.userPoolWebClientId,
        loginWith: {
          oauth: {
            domain: c.Auth.oauth.domain,
            scopes: c.Auth.oauth.scope,
            redirectSignIn: [c.Auth.oauth.redirectSignIn],
            redirectSignOut: [c.Auth.oauth.redirectSignOut],
            responseType: c.Auth.oauth.responseType === "token" ? "token" : "code",
          },
        },
      },
    },
  };
}

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
   *     - Failure (no session): redirect to the Cognito Managed Login
   *       page, which presents both the username/password form and the
   *       federated Mass SSO button (no provider is forced).
   *  4. If both the auth check and the redirect fail (e.g. network
   *     error), display the error state.
   */
  useEffect(() => {
    (async () => {
      let currentConfig: AppConfig | undefined;
      try {
        const result = await fetch("/aws-exports.json");
        const awsExports = (await result.json()) as AppConfig;
        currentConfig = awsExports;
        Amplify.configure(toResourcesConfig(awsExports));
        const user = await getCurrentUser();
        if (user) {
          setAuthenticated(true);
        }
        setConfig(awsExports);
        setConfigured(true);
      } catch {
        // Config fetch/parse failed — we can't even redirect; show the error.
        if (!currentConfig) {
          setError(true);
          return;
        }
        try {
          // Land on the Cognito Managed Login page, which presents BOTH the
          // username/password form (native Cognito users) and the federated
          // "Sign in with Mass SSO" button. Passing a specific provider here
          // would skip the page and bounce straight to SSO — exactly what
          // locked native Cognito users out before.
          signInWithRedirect();
        } catch {
          setError(true);
        }
      }
    })();
  }, []);

  /**
   * Re-authentication guard -- if the config has loaded but the user is
   * not authenticated (e.g. token expired between effects), send the user
   * to the Managed Login page again.
   */
  useEffect(() => {
    if (!authenticated && configured) {
      // Same as above: send the user to the Managed Login page so both
      // native Cognito and federated Mass SSO sign-in remain available.
      Utils.redirectToLogin();
    }
  }, [authenticated, configured]);

  /**
   * Auto sign-out on session loss. When a token can no longer be refreshed
   * (expired or revoked), Amplify emits `tokenRefresh_failure`. Rather than let
   * the next API call fail with a cryptic "not authenticated" notification, send
   * the user straight back to the managed login to re-authenticate.
   */
  useEffect(() => {
    const stopListening = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "tokenRefresh_failure") {
        setAuthenticated(false);
        Utils.redirectToLogin();
      }
    });
    return stopListening;
  }, []);

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
          role="status"
          aria-live="polite"
          sx={{
            width: "100%",
            height: "100%",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 1,
          }}
        >
          <CircularProgress size={20} aria-hidden="true" />
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
