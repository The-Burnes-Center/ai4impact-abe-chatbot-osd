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
import { StorageHelper } from "../common/helpers/storage-helper";

interface BaseAppLayoutProps {
  children?: ReactElement | ReactElement[];
  info?: ReactElement;
}

export default function BaseAppLayout({ children }: BaseAppLayoutProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(
    () => StorageHelper.getNavigationPanelState().collapsed ?? false,
  );
  const [needsRefresh, setNeedsRefresh] = useState(true);

  const drawerContent = <NavigationPanel />;

  const handleMenuClick = () => {
    if (isMobile) {
      setMobileOpen((v) => !v);
    } else {
      setDesktopCollapsed((prev) => {
        const next = !prev;
        StorageHelper.setNavigationPanelState({ collapsed: next });
        return next;
      });
    }
  };

  return (
    <SessionRefreshContext.Provider value={{ needsRefresh, setNeedsRefresh }}>
      <NotificationProvider>
        {/* Fills the slot the parent gives us (between BrandBanner and Footer
            in App), so the whole shell — banner, header, body, footer — fits
            in one viewport with the body as the only scrollable region. */}
        <Box sx={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <GlobalHeader
            onMenuClick={handleMenuClick}
            menuExpanded={isMobile ? mobileOpen : !desktopCollapsed}
          />

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

            {/* Desktop drawer — hidden when collapsed so main content reclaims
                the full width. Paper fills available height so NavigationPanel's
                pinned-top/bottom + scrollable-middle layout can take effect. */}
            <Drawer
              variant="permanent"
              sx={{
                display: { xs: "none", md: desktopCollapsed ? "none" : "block" },
                width: DRAWER_WIDTH,
                flexShrink: 0,
                "& .MuiDrawer-paper": {
                  width: DRAWER_WIDTH,
                  boxSizing: "border-box",
                  position: "static",
                  height: "100%",
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
                width: {
                  md: desktopCollapsed ? "100%" : `calc(100% - ${DRAWER_WIDTH}px)`,
                },
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
