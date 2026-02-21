import { createTheme, type Theme } from "@mui/material/styles";
import type { ThemeMode } from "./helpers/storage-helper";

export const DRAWER_WIDTH = 280;

export const tokens = {
  radii: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    full: 9999,
  },
  shadows: {
    xs: "0 1px 2px rgba(0,0,0,0.05)",
    sm: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
    md: "0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)",
    lg: "0 8px 24px rgba(0,0,0,0.10), 0 4px 8px rgba(0,0,0,0.04)",
    xl: "0 16px 48px rgba(0,0,0,0.12), 0 8px 16px rgba(0,0,0,0.04)",
  },
  transitions: {
    fast: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
    normal: "250ms cubic-bezier(0.4, 0, 0.2, 1)",
    slow: "400ms cubic-bezier(0.4, 0, 0.2, 1)",
  },
  colors: {
    light: {
      primary: "#14558F",
      primaryDark: "#0A3D6B",
      primaryLight: "#E8F2FC",
      secondary: "#D97706",
      secondaryLight: "#FEF3C7",
      surface: "#FFFFFF",
      surfaceAlt: "#F7F8FA",
      paper: "#FFFFFF",
      border: "#E2E5EA",
      borderSubtle: "#EEF0F3",
      textPrimary: "#1A1D23",
      textSecondary: "#555D6B",
      textTertiary: "#8A919E",
      headerBg: "#0B2847",
      headerText: "#FFFFFF",
      sidebarBg: "#FBFBFC",
      chatHumanBg: "#14558F",
      chatHumanText: "#FFFFFF",
      chatAiBg: "#F7F8FA",
      chatAiBorder: "#E8EDF2",
      success: "#0D7C3F",
      successLight: "#ECFDF3",
      warning: "#B45309",
      warningLight: "#FFFBEB",
      error: "#C4320A",
      errorLight: "#FEF3F2",
      info: "#0B6BCB",
      infoLight: "#EBF5FF",
      codeBlockBg: "#F4F5F7",
      tableBorder: "#E2E5EA",
      tableStripeBg: "#FAFBFC",
      tableHeaderBg: "#F2F4F7",
      skeletonBase: "#E8EDF2",
      skeletonHighlight: "#F4F5F7",
    },
    dark: {
      primary: "#6DB3F2",
      primaryDark: "#4A9BE8",
      primaryLight: "#172B45",
      secondary: "#FBBF24",
      secondaryLight: "#342A11",
      surface: "#0F1B2D",
      surfaceAlt: "#162235",
      paper: "#1A2B40",
      border: "#2A3B52",
      borderSubtle: "#1F3048",
      textPrimary: "#E8EDF2",
      textSecondary: "#9DABB8",
      textTertiary: "#6B7A8D",
      headerBg: "#091A30",
      headerText: "#E8EDF2",
      sidebarBg: "#0D1926",
      chatHumanBg: "#1E4D7B",
      chatHumanText: "#E8EDF2",
      chatAiBg: "#162235",
      chatAiBorder: "#2A3B52",
      success: "#34D27B",
      successLight: "#0D2818",
      warning: "#FBBF24",
      warningLight: "#2A2008",
      error: "#F87171",
      errorLight: "#2D1212",
      info: "#6DB3F2",
      infoLight: "#0D1F3A",
      codeBlockBg: "#1A2B40",
      tableBorder: "#2A3B52",
      tableStripeBg: "#162235",
      tableHeaderBg: "#1A2B40",
      skeletonBase: "#1F3048",
      skeletonHighlight: "#2A3B52",
    },
  },
} as const;

function applyTokensAsCSSVars(mode: ThemeMode) {
  const c = tokens.colors[mode];
  const root = document.documentElement;
  Object.entries(c).forEach(([key, value]) => {
    root.style.setProperty(`--abe-${key}`, value);
  });
  root.style.setProperty("--abe-radius-xs", `${tokens.radii.xs}px`);
  root.style.setProperty("--abe-radius-sm", `${tokens.radii.sm}px`);
  root.style.setProperty("--abe-radius-md", `${tokens.radii.md}px`);
  root.style.setProperty("--abe-radius-lg", `${tokens.radii.lg}px`);
  root.style.setProperty("--abe-radius-xl", `${tokens.radii.xl}px`);
  root.style.setProperty("--abe-shadow-xs", tokens.shadows.xs);
  root.style.setProperty("--abe-shadow-sm", tokens.shadows.sm);
  root.style.setProperty("--abe-shadow-md", tokens.shadows.md);
  root.style.setProperty("--abe-shadow-lg", tokens.shadows.lg);
  root.style.setProperty("--abe-transition-fast", tokens.transitions.fast);
  root.style.setProperty("--abe-transition-normal", tokens.transitions.normal);
}

export function buildTheme(mode: ThemeMode): Theme {
  applyTokensAsCSSVars(mode);
  const c = tokens.colors[mode];

  return createTheme({
    palette: {
      mode,
      primary: { main: c.primary, dark: c.primaryDark, light: c.primaryLight },
      background: { default: c.surface, paper: c.paper },
      text: { primary: c.textPrimary, secondary: c.textSecondary },
      success: { main: c.success, light: c.successLight },
      warning: { main: c.warning, light: c.warningLight },
      error: { main: c.error, light: c.errorLight },
      info: { main: c.info, light: c.infoLight },
      divider: c.border,
    },
    shape: { borderRadius: tokens.radii.sm },
    typography: {
      fontFamily:
        '"Inter", "Open Sans", "Helvetica Neue", Roboto, Arial, sans-serif',
      h1: { fontSize: "2rem", fontWeight: 700, lineHeight: 1.25, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.5rem", fontWeight: 700, lineHeight: 1.3, letterSpacing: "-0.01em" },
      h3: { fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.4 },
      h4: { fontSize: "1.125rem", fontWeight: 600, lineHeight: 1.4 },
      h5: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.5 },
      h6: { fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5 },
      subtitle1: { fontSize: "1rem", fontWeight: 600, lineHeight: 1.5 },
      subtitle2: { fontSize: "0.875rem", fontWeight: 600, lineHeight: 1.5 },
      body1: { fontSize: "0.9375rem", lineHeight: 1.6 },
      body2: { fontSize: "0.8125rem", lineHeight: 1.5 },
      caption: { fontSize: "0.75rem", lineHeight: 1.5, color: c.textTertiary },
      button: { textTransform: "none" as const, fontWeight: 600, fontSize: "0.875rem" },
    },
    shadows: [
      "none",
      tokens.shadows.xs,
      tokens.shadows.sm,
      tokens.shadows.sm,
      tokens.shadows.md,
      tokens.shadows.md,
      tokens.shadows.md,
      tokens.shadows.lg,
      tokens.shadows.lg,
      tokens.shadows.lg,
      tokens.shadows.lg,
      tokens.shadows.lg,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
      tokens.shadows.xl,
    ] as Theme["shadows"],
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          html: {
            scrollBehavior: "smooth",
          },
          body: {
            scrollbarWidth: "thin",
            backgroundColor: c.surface,
            transition: `background-color ${tokens.transitions.normal}`,
          },
          "*:focus-visible": {
            outline: `2px solid ${c.primary}`,
            outlineOffset: "2px",
            borderRadius: tokens.radii.xs,
          },
          ".sr-only": {
            position: "absolute",
            width: "1px",
            height: "1px",
            padding: 0,
            margin: "-1px",
            overflow: "hidden",
            clip: "rect(0,0,0,0)",
            whiteSpace: "nowrap",
            border: 0,
          },
          "@media (prefers-reduced-motion: reduce)": {
            "*": {
              animationDuration: "0.01ms !important",
              animationIterationCount: "1 !important",
              transitionDuration: "0.01ms !important",
            },
          },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.md,
            border: `1px solid ${c.border}`,
            backgroundImage: "none",
            transition: `border-color ${tokens.transitions.fast}, box-shadow ${tokens.transitions.fast}`,
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.sm,
            textTransform: "none" as const,
            fontWeight: 600,
            padding: "8px 20px",
            transition: `all ${tokens.transitions.fast}`,
            "&:hover": {
              transform: "translateY(-1px)",
              boxShadow: tokens.shadows.sm,
            },
            "&:active": {
              transform: "translateY(0)",
            },
          },
          sizeSmall: {
            padding: "4px 12px",
            fontSize: "0.8125rem",
          },
          sizeLarge: {
            padding: "12px 28px",
            fontSize: "1rem",
          },
          contained: {
            "&:hover": {
              boxShadow: tokens.shadows.md,
            },
          },
          outlined: {
            borderColor: c.border,
            "&:hover": {
              borderColor: c.primary,
              backgroundColor: c.primaryLight,
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.sm,
            transition: `all ${tokens.transitions.fast}`,
            "&:hover": {
              backgroundColor: mode === "light" ? "rgba(0,0,0,0.04)" : "rgba(255,255,255,0.06)",
            },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: tokens.radii.lg,
            border: `1px solid ${c.border}`,
            boxShadow: tokens.shadows.xl,
          },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.md,
            border: `1px solid ${c.border}`,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.sm,
            fontWeight: 500,
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            "& .MuiOutlinedInput-root": {
              borderRadius: tokens.radii.sm,
              "& fieldset": {
                borderColor: c.border,
                transition: `border-color ${tokens.transitions.fast}`,
              },
              "&:hover fieldset": {
                borderColor: c.textTertiary,
              },
            },
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.sm,
            border: "1px solid",
            fontWeight: 500,
          },
          standardInfo: {
            borderColor: c.info,
            backgroundColor: c.infoLight,
          },
          standardSuccess: {
            borderColor: c.success,
            backgroundColor: c.successLight,
          },
          standardWarning: {
            borderColor: c.warning,
            backgroundColor: c.warningLight,
          },
          standardError: {
            borderColor: c.error,
            backgroundColor: c.errorLight,
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            width: DRAWER_WIDTH,
            borderRight: "none",
            boxShadow: mode === "light" ? "1px 0 8px rgba(0,0,0,0.06)" : "1px 0 8px rgba(0,0,0,0.2)",
            backgroundColor: c.sidebarBg,
          },
        },
      },
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            boxShadow: mode === "light" ? "0 1px 3px rgba(0,0,0,0.1)" : "0 1px 3px rgba(0,0,0,0.3)",
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.sm,
            margin: "2px 8px",
            transition: `all ${tokens.transitions.fast}`,
            "&.Mui-selected": {
              backgroundColor: c.primaryLight,
              borderLeft: `3px solid ${c.primary}`,
              "&:hover": {
                backgroundColor: c.primaryLight,
              },
            },
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: "none" as const,
            fontWeight: 600,
            fontSize: "0.875rem",
            minHeight: 44,
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          indicator: {
            borderRadius: 2,
            height: 3,
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            borderColor: c.border,
            padding: "12px 16px",
          },
          head: {
            fontWeight: 600,
            backgroundColor: c.tableHeaderBg,
            fontSize: "0.8125rem",
            textTransform: "uppercase" as const,
            letterSpacing: "0.5px",
            color: c.textSecondary,
          },
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: {
            transition: `background-color ${tokens.transitions.fast}`,
            "&:nth-of-type(even)": {
              backgroundColor: c.tableStripeBg,
            },
            "&:hover": {
              backgroundColor: mode === "light" ? "rgba(20,85,143,0.04)" : "rgba(109,179,242,0.06)",
            },
          },
        },
      },
      MuiTableContainer: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.md,
            border: `1px solid ${c.border}`,
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            borderRadius: tokens.radii.sm,
            fontSize: "0.75rem",
            fontWeight: 500,
          },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.full,
            height: 6,
          },
          bar: {
            borderRadius: tokens.radii.full,
          },
        },
      },
      MuiBreadcrumbs: {
        styleOverrides: {
          root: {
            fontSize: "0.8125rem",
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: tokens.radii.md,
            border: `1px solid ${c.border}`,
            boxShadow: tokens.shadows.lg,
            marginTop: 4,
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.xs,
            margin: "2px 4px",
            fontSize: "0.875rem",
          },
        },
      },
      MuiSkeleton: {
        styleOverrides: {
          root: {
            borderRadius: tokens.radii.sm,
          },
        },
      },
    },
  });
}
