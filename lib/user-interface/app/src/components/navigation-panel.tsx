import { useContext, useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Skeleton from "@mui/material/Skeleton";
import ExpandLess from "@mui/icons-material/ExpandLess";
import ExpandMore from "@mui/icons-material/ExpandMore";
import RefreshIcon from "@mui/icons-material/Refresh";
import AddIcon from "@mui/icons-material/Add";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import FeedbackOutlinedIcon from "@mui/icons-material/FeedbackOutlined";
import BarChartOutlinedIcon from "@mui/icons-material/BarChartOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import TipsAndUpdatesOutlinedIcon from "@mui/icons-material/TipsAndUpdatesOutlined";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import { AppContext } from "../common/app-context";
import { ApiClient } from "../common/api-client/api-client";
import { Auth } from "aws-amplify";
import { v4 as uuidv4 } from "uuid";
import { SessionRefreshContext } from "../common/session-refresh-context";
import { useNotifications } from "./notif-manager";
import { Utils } from "../common/utils.js";

interface SessionItem {
  session_id: string;
  title: string;
}

interface AdminLink {
  text: string;
  href: string;
  icon: React.ReactNode;
}

const adminLinkDefinitions: AdminLink[] = [
  { text: "Data", href: "/admin/data", icon: <FolderOutlinedIcon fontSize="small" /> },
  { text: "User Feedback", href: "/admin/user-feedback", icon: <FeedbackOutlinedIcon fontSize="small" /> },
  { text: "Metrics", href: "/admin/metrics", icon: <BarChartOutlinedIcon fontSize="small" /> },
  { text: "LLM Evaluation", href: "/admin/llm-evaluation", icon: <ScienceOutlinedIcon fontSize="small" /> },
];

export default function NavigationPanel() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const location = useLocation();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [adminLinks, setAdminLinks] = useState<AdminLink[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { needsRefresh, setNeedsRefresh } = useContext(SessionRefreshContext);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const { addNotification, removeNotification } = useNotifications();
  const [sessionsOpen, setSessionsOpen] = useState(true);
  const [adminOpen, setAdminOpen] = useState(true);

  const loadSessions = async () => {
    if (loadingSessions) return;
    setLoadingSessions(true);
    try {
      const user = await Auth.currentAuthenticatedUser();
      const username = user?.username;
      if (username && needsRefresh) {
        const fetchedSessions = await apiClient.sessions.getSessions(username);
        setSessions(fetchedSessions);
        await loadAdminLinks();
        if (!loaded) setLoaded(true);
        setNeedsRefresh(false);
      }
    } catch (error: any) {
      console.error("Failed to load sessions:", error);
      setLoaded(true);
      addNotification("error", "Could not load sessions: " + (error?.message ?? "Unknown error"));
      addNotification("info", "Please refresh the page");
    } finally {
      setLoadingSessions(false);
    }
  };

  const loadAdminLinks = async () => {
    try {
      const result = await Auth.currentAuthenticatedUser();
      const admin = result?.signInUserSession?.idToken?.payload["custom:role"];
      if (admin) {
        const data = JSON.parse(admin);
        if (data.includes("Admin") || data.includes("Master Admin")) {
          setAdminLinks(adminLinkDefinitions);
        }
      }
    } catch (e) {
      console.error("Admin check failed:", e);
    }
  };

  useEffect(() => {
    loadSessions();
  }, [needsRefresh]);

  const onReloadClick = async () => {
    setNeedsRefresh(true);
    const id = addNotification("success", "Sessions reloaded successfully!");
    Utils.delay(3000).then(() => removeNotification(id));
  };

  const handleNewSession = () => {
    navigate(`/chatbot/playground/${uuidv4()}`);
  };

  return (
    <Box
      component="nav"
      role="navigation"
      aria-label="Main navigation"
      sx={{
        overflow: "auto",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box sx={{ p: 2, pt: 1.5 }}>
        <Button
          variant="contained"
          fullWidth
          startIcon={<AddIcon />}
          onClick={handleNewSession}
          aria-label="Start a new chat session"
          sx={{
            borderRadius: 9999,
            py: 1.2,
            fontWeight: 600,
            fontSize: "0.875rem",
          }}
        >
          New session
        </Button>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto" }}>
        {!loaded ? (
          <Box sx={{ px: 2, py: 1 }}>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton
                key={i}
                variant="rounded"
                height={32}
                sx={{ mb: 1, borderRadius: 1 }}
              />
            ))}
          </Box>
        ) : (
          <>
            <List dense disablePadding>
              <ListItemButton
                onClick={() => setSessionsOpen(!sessionsOpen)}
                sx={{ mx: 1, borderRadius: 1 }}
                aria-expanded={sessionsOpen}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <ChatBubbleOutlineIcon fontSize="small" sx={{ opacity: 0.6 }} />
                </ListItemIcon>
                <ListItemText
                  primary="Sessions"
                  primaryTypographyProps={{
                    fontWeight: 600,
                    fontSize: "0.75rem",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    color: "text.secondary",
                  }}
                />
                {sessionsOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
              </ListItemButton>
              <Collapse in={sessionsOpen} timeout={200} unmountOnExit>
                <List dense disablePadding>
                  {sessions.length === 0 && (
                    <Typography
                      variant="caption"
                      sx={{ px: 3, py: 1.5, display: "block", color: "text.secondary" }}
                    >
                      No sessions yet. Start a new one!
                    </Typography>
                  )}
                  {sessions.map((session) => (
                    <Tooltip
                      key={session.session_id}
                      title={session.title}
                      placement="right"
                      enterDelay={500}
                    >
                      <ListItemButton
                        selected={location.pathname === `/chatbot/playground/${session.session_id}`}
                        onClick={() => navigate(`/chatbot/playground/${session.session_id}`)}
                        sx={{ pl: 2.5 }}
                      >
                        <ListItemText
                          primary={session.title}
                          primaryTypographyProps={{
                            noWrap: true,
                            fontSize: "0.8125rem",
                          }}
                        />
                      </ListItemButton>
                    </Tooltip>
                  ))}
                  <Box sx={{ display: "flex", justifyContent: "center", gap: 1, py: 1 }}>
                    <Button
                      size="small"
                      onClick={() => navigate("/chatbot/sessions")}
                    >
                      View All
                    </Button>
                    <Tooltip title="Refresh sessions">
                      <IconButton
                        size="small"
                        onClick={onReloadClick}
                        disabled={loadingSessions}
                        aria-label="Refresh sessions"
                      >
                        {loadingSessions ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
                      </IconButton>
                    </Tooltip>
                  </Box>
                </List>
              </Collapse>
            </List>

            <Divider sx={{ my: 0.5, mx: 2 }} />

            <List dense disablePadding>
              <ListItemButton
                onClick={() => navigate("/chatbot/tips")}
                selected={location.pathname === "/chatbot/tips"}
                sx={{ mx: 1, borderRadius: 1 }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <TipsAndUpdatesOutlinedIcon fontSize="small" sx={{ opacity: 0.6 }} />
                </ListItemIcon>
                <ListItemText
                  primary="Tips & Questions"
                  primaryTypographyProps={{ fontSize: "0.8125rem" }}
                />
              </ListItemButton>
            </List>

            {adminLinks.length > 0 && (
              <>
                <Divider sx={{ my: 0.5, mx: 2 }} />
                <List dense disablePadding>
                  <ListItemButton
                    onClick={() => setAdminOpen(!adminOpen)}
                    sx={{ mx: 1, borderRadius: 1 }}
                    aria-expanded={adminOpen}
                  >
                    <ListItemText
                      primary="Admin"
                      primaryTypographyProps={{
                        fontWeight: 600,
                        fontSize: "0.75rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                        color: "text.secondary",
                      }}
                    />
                    {adminOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                  </ListItemButton>
                  <Collapse in={adminOpen} timeout={200} unmountOnExit>
                    <List dense disablePadding>
                      {adminLinks.map((link) => (
                        <ListItemButton
                          key={link.href}
                          selected={location.pathname === link.href}
                          onClick={() => navigate(link.href)}
                          sx={{ pl: 2 }}
                        >
                          <ListItemIcon sx={{ minWidth: 32, color: "text.secondary" }}>
                            {link.icon}
                          </ListItemIcon>
                          <ListItemText
                            primary={link.text}
                            primaryTypographyProps={{ fontSize: "0.8125rem" }}
                          />
                        </ListItemButton>
                      ))}
                    </List>
                  </Collapse>
                </List>
              </>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
