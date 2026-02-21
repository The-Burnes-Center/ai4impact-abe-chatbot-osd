import { ReactElement, useState } from "react";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import Toolbar from "@mui/material/Toolbar";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useTheme } from "@mui/material/styles";
import NavigationPanel from "./navigation-panel";
import { SessionRefreshContext } from "../common/session-refresh-context";
import { NotificationProvider } from "./notif-manager";
import NotificationBar from "./notif-flashbar";
import { DRAWER_WIDTH } from "../common/theme";
import GlobalHeader from "./global-header";

interface BaseAppLayoutProps {
  children?: ReactElement | ReactElement[];
  info?: ReactElement;
}

export default function BaseAppLayout({ children, info }: BaseAppLayoutProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(true);

  const drawerContent = <NavigationPanel />;

  return (
    <SessionRefreshContext.Provider value={{ needsRefresh, setNeedsRefresh }}>
      <NotificationProvider>
        <Box sx={{ display: "flex" }}>
          {/* Skip to content link for accessibility */}
          <Box
            component="a"
            href="#main-content"
            className="sr-only"
            sx={{
              "&:focus": {
                position: "fixed",
                top: 8,
                left: "50%",
                transform: "translateX(-50%)",
                zIndex: 9999,
                clip: "auto",
                width: "auto",
                height: "auto",
                overflow: "visible",
                whiteSpace: "normal",
                bgcolor: "primary.main",
                color: "#fff",
                px: 3,
                py: 1.5,
                borderRadius: 2,
                fontWeight: 600,
                fontSize: "0.875rem",
                textDecoration: "none",
                boxShadow: 4,
              },
            }}
          >
            Skip to main content
          </Box>

          <GlobalHeader onMenuClick={() => setMobileOpen(!mobileOpen)} />

          {/* Mobile drawer */}
          <Drawer
            variant="temporary"
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            ModalProps={{ keepMounted: true }}
            sx={{
              display: { xs: "block", md: "none" },
              "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
            }}
          >
            <Toolbar sx={{ minHeight: { xs: 56, sm: 64 } }} />
            {drawerContent}
          </Drawer>

          {/* Desktop drawer */}
          <Drawer
            variant="permanent"
            sx={{
              display: { xs: "none", md: "block" },
              width: DRAWER_WIDTH,
              flexShrink: 0,
              "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
            }}
          >
            <Toolbar sx={{ minHeight: { xs: 56, sm: 64 } }} />
            {drawerContent}
          </Drawer>

          {/* Main content */}
          <Box
            component="main"
            id="main-content"
            role="main"
            tabIndex={-1}
            sx={{
              flexGrow: 1,
              width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
              minHeight: "100vh",
              outline: "none",
            }}
          >
            <Toolbar sx={{ minHeight: { xs: 56, sm: 64 } }} />
            <Box
              sx={{
                p: { xs: 2, sm: 2.5, md: 3 },
                maxWidth: 1200,
                mx: "auto",
              }}
            >
              <NotificationBar />
              {children}
            </Box>
          </Box>
        </Box>
      </NotificationProvider>
    </SessionRefreshContext.Provider>
  );
}
