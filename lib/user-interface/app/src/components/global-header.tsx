import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Box from "@mui/material/Box";
import Avatar from "@mui/material/Avatar";
import Tooltip from "@mui/material/Tooltip";
import Stack from "@mui/material/Stack";
import DarkModeOutlinedIcon from "@mui/icons-material/DarkModeOutlined";
import LightModeOutlinedIcon from "@mui/icons-material/LightModeOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import LogoutIcon from "@mui/icons-material/Logout";
import { StorageHelper, ThemeMode } from "../common/helpers/storage-helper";
import { Auth } from "aws-amplify";
import { CHATBOT_NAME } from "../common/constants";
import { tokens } from "../common/theme";

interface GlobalHeaderProps {
  onMenuClick?: () => void;
}

export default function GlobalHeader({ onMenuClick }: GlobalHeaderProps) {
  const navigate = useNavigate();
  const [userName, setUserName] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(StorageHelper.getTheme());
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await Auth.currentAuthenticatedUser();
        if (!result || Object.keys(result).length === 0) {
          Auth.signOut();
          return;
        }
        const name = result?.signInUserSession?.idToken?.payload?.name;
        const email = result?.signInUserSession?.idToken?.payload?.email;
        setUserName(name || email || null);
      } catch {
        try { Auth.signOut(); } catch { /* ignore */ }
      }
    })();
  }, []);

  const onChangeThemeClick = () => {
    if (theme === "dark") {
      setTheme(StorageHelper.applyTheme("light"));
    } else {
      setTheme(StorageHelper.applyTheme("dark"));
    }
  };

  const handleSignOut = () => {
    setAnchorEl(null);
    Auth.signOut();
  };

  const c = tokens.colors[theme];
  const initials = userName
    ? userName.split(/[\s@]+/)[0].charAt(0).toUpperCase()
    : "U";

  return (
    <AppBar
      position="fixed"
      role="banner"
      sx={{
        zIndex: (t) => t.zIndex.drawer + 1,
        bgcolor: c.headerBg,
        borderBottom: `1px solid ${theme === "light" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.05)"}`,
      }}
    >
      <Toolbar sx={{ minHeight: { xs: 56, sm: 64 }, px: { xs: 1.5, sm: 2.5 } }}>
        {onMenuClick && (
          <IconButton
            color="inherit"
            edge="start"
            onClick={onMenuClick}
            aria-label="Open navigation menu"
            sx={{ mr: 1, display: { md: "none" } }}
          >
            <MenuIcon />
          </IconButton>
        )}
        <Box
          component="button"
          onClick={() => navigate("/chatbot/playground")}
          aria-label="Go to home page"
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1.5,
            background: "none",
            border: "none",
            cursor: "pointer",
            p: 0,
            mr: 2,
            borderRadius: 1,
            "&:focus-visible": {
              outline: "2px solid rgba(255,255,255,0.6)",
              outlineOffset: 4,
            },
          }}
        >
          <Box
            component="img"
            src="/images/stateseal-color.png"
            alt=""
            sx={{ height: { xs: 32, sm: 36 } }}
          />
          <Typography
            variant="subtitle1"
            noWrap
            sx={{
              color: c.headerText,
              fontWeight: 700,
              fontSize: { xs: "0.875rem", sm: "1rem" },
              letterSpacing: "-0.01em",
            }}
          >
            {CHATBOT_NAME}
          </Typography>
        </Box>

        <Box sx={{ flexGrow: 1 }} />

        <Stack direction="row" spacing={0.5} alignItems="center">
          <Tooltip title="Help & Guide">
            <IconButton
              color="inherit"
              onClick={() => navigate("/help")}
              aria-label="Help and guide"
              sx={{ color: c.headerText, "&:hover": { bgcolor: "rgba(255,255,255,0.12)" } }}
            >
              <HelpOutlineIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
            <IconButton
              color="inherit"
              onClick={onChangeThemeClick}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              sx={{ color: c.headerText, "&:hover": { bgcolor: "rgba(255,255,255,0.12)" } }}
            >
              {theme === "dark" ? (
                <LightModeOutlinedIcon />
              ) : (
                <DarkModeOutlinedIcon />
              )}
            </IconButton>
          </Tooltip>

          <Tooltip title={userName || "Account"}>
            <IconButton
              onClick={(e) => setAnchorEl(e.currentTarget)}
              aria-label="Account menu"
              aria-haspopup="true"
              sx={{ ml: 0.5 }}
            >
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  fontSize: "0.8125rem",
                  fontWeight: 700,
                  bgcolor: "rgba(255,255,255,0.15)",
                  color: c.headerText,
                }}
              >
                {initials}
              </Avatar>
            </IconButton>
          </Tooltip>
        </Stack>

        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={() => setAnchorEl(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          {userName && (
            <MenuItem disabled sx={{ opacity: "0.7 !important", fontSize: "0.8125rem" }}>
              {userName}
            </MenuItem>
          )}
          <MenuItem onClick={handleSignOut} sx={{ gap: 1 }}>
            <LogoutIcon fontSize="small" />
            Sign out
          </MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );
}
