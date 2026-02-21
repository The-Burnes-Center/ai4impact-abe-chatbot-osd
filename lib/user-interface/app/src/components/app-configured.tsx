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

  useEffect(() => {
    (async () => {
      let currentConfig: AppConfig;
      try {
        const result = await fetch("/aws-exports.json");
        const awsExports = await result.json();
        currentConfig = Amplify.configure(awsExports) as AppConfig | null;
        const user = await Auth.currentAuthenticatedUser();
        if (user) {
          setAuthenticated(true);
        }
        setConfig(awsExports);
        setConfigured(true);
      } catch (e) {
        console.error("Authentication check error:", e);
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

  useEffect(() => {
    if (!authenticated && configured) {
      if (config!.federatedSignInProvider != "") {
        Auth.federatedSignIn({ customProvider: config!.federatedSignInProvider });
      } else {
        Auth.federatedSignIn();
      }
    }
  }, [authenticated, configured]);

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
