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
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import { AppContext } from "../common/app-context";
import { ApiClient } from "../common/api-client/api-client";
import { Auth } from "aws-amplify";
import { v4 as uuidv4 } from "uuid";
import { SessionRefreshContext } from "../common/session-refresh-context";
import { useNotifications } from "./notif-manager";
import { Utils } from "../common/utils.js";

const VISIBLE_SESSION_COUNT = 10;

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
  { text: "Analytics", href: "/admin/metrics", icon: <BarChartOutlinedIcon fontSize="small" /> },
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
    } catch {
      // Admin check failed — user is not admin
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

  const visibleSessions = sessions.slice(0, VISIBLE_SESSION_COUNT);
  const hasMore = sessions.length > VISIBLE_SESSION_COUNT;

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
      {/* New session button */}
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
          New chat
        </Button>
      </Box>

      <Box sx={{ flex: 1 }}>
        {!loaded ? (
          <Box sx={{ px: 2, py: 1 }}>
            {[1, 2, 3, 4, 5, 6].map((i) => (
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
            {/* Sessions header */}
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 2,
                pt: 0.5,
                pb: 0.25,
              }}
            >
              <ChatBubbleOutlineIcon sx={{ fontSize: 15, opacity: 0.5 }} />
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  color: "text.secondary",
                  fontSize: "0.7rem",
                  flex: 1,
                }}
              >
                Recent chats
              </Typography>
              <Tooltip title="Refresh sessions" placement="top">
                <IconButton
                  size="small"
                  onClick={onReloadClick}
                  disabled={loadingSessions}
                  aria-label="Refresh sessions"
                  sx={{ p: 0.375 }}
                >
                  {loadingSessions ? (
                    <CircularProgress size={13} />
                  ) : (
                    <RefreshIcon sx={{ fontSize: 15, opacity: 0.5 }} />
                  )}
                </IconButton>
              </Tooltip>
            </Box>

            {/* Session list */}
            <List dense disablePadding>
              {sessions.length === 0 && (
                <Typography
                  variant="caption"
                  sx={{ px: 3, py: 1.5, display: "block", color: "text.secondary" }}
                >
                  No sessions yet. Start a new one!
                </Typography>
              )}
              {visibleSessions.map((session) => (
                <Tooltip
                  key={session.session_id}
                  title={session.title}
                  placement="right"
                  enterDelay={200}
                >
                  <ListItemButton
                    selected={location.pathname === `/chatbot/playground/${session.session_id}`}
                    onClick={() => navigate(`/chatbot/playground/${session.session_id}`)}
                    sx={{ pl: 2.5, mx: 0.5, borderRadius: 1 }}
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
              {hasMore && (
                <Box sx={{ px: 1, pt: 0.5 }}>
                  <Button
                    size="small"
                    fullWidth
                    onClick={() => navigate("/chatbot/sessions")}
                    sx={{ fontSize: "0.75rem", color: "text.secondary" }}
                  >
                    View all ({sessions.length})
                  </Button>
                </Box>
              )}
            </List>

            {/* Admin */}
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
