import { ReactElement, useState } from "react";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
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

export default function BaseAppLayout({ children }: BaseAppLayoutProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(true);

  const drawerContent = <NavigationPanel />;

  return (
    <SessionRefreshContext.Provider value={{ needsRefresh, setNeedsRefresh }}>
      <NotificationProvider>
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <GlobalHeader onMenuClick={isMobile ? () => setMobileOpen(!mobileOpen) : undefined} />

          <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
            {/* Mobile drawer */}
            <Drawer
              variant="temporary"
              open={mobileOpen}
              onClose={() => setMobileOpen(false)}
              ModalProps={{ keepMounted: true }}
              PaperProps={{ "aria-label": "Main navigation" }}
              sx={{
                display: { xs: "block", md: "none" },
                "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
              }}
            >
              {drawerContent}
            </Drawer>

            {/* Desktop drawer */}
            <Drawer
              variant="permanent"
              sx={{
                display: { xs: "none", md: "block" },
                width: DRAWER_WIDTH,
                flexShrink: 0,
                "& .MuiDrawer-paper": {
                  width: DRAWER_WIDTH,
                  boxSizing: "border-box",
                  position: "static",
                },
              }}
            >
              {drawerContent}
            </Drawer>

            {/* Main content */}
            <Box
              component="main"
              id="main-content"
              tabIndex={-1}
              sx={{
                flexGrow: 1,
                width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
                display: "flex",
                flexDirection: "column",
                "&:focus:not(:focus-visible)": { outline: "none" },
                minHeight: 0,
              }}
            >
              <Box
                sx={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  px: { xs: 2, sm: 2.5, md: 3 },
                  pt: { xs: 2, sm: 2.5, md: 3 },
                  pb: 0,
                  width: "100%",
                  overflow: "auto",
                }}
              >
                <NotificationBar />
                {children}
              </Box>
            </Box>
          </Box>
        </Box>
      </NotificationProvider>
    </SessionRefreshContext.Provider>
  );
}
