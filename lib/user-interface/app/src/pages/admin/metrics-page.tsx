import React, { useState, useEffect, useContext } from "react";
import { Auth } from "aws-amplify";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  CircularProgress,
  Alert,
  IconButton,
  Chip,
  Collapse,
  Stack,
  Skeleton,
  Tooltip,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import PeopleIcon from "@mui/icons-material/People";
import ChatIcon from "@mui/icons-material/Chat";
import ForumIcon from "@mui/icons-material/Forum";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import PersonIcon from "@mui/icons-material/Person";
import { LineChart } from "@mui/x-charts/LineChart";
import { BarChart } from "@mui/x-charts/BarChart";
import AdminPageLayout from "../../components/admin-page-layout";
import { useDocumentTitle } from "../../common/hooks/use-document-title";

interface MetricsData {
  unique_users: number;
  total_sessions: number;
  total_messages: number;
  avg_messages_per_session: number;
  peak_hour: string;
  daily_breakdown: Array<{
    date: string;
    sessions: number;
    messages: number;
    unique_users: number;
    users?: Array<{
      user_id: string;
      display_name: string;
      agency: string;
      sessions: number;
      messages: number;
    }>;
  }>;
}

interface FAQSample {
  question: string;
  display_name?: string;
  agency?: string;
}

interface FAQData {
  topics: Array<{
    topic: string;
    count: number;
    sample_questions: FAQSample[];
  }>;
  total_classified: number;
}

interface UserData {
  users: Array<{
    user_id: string;
    display_name: string;
    agency: string;
    messages: number;
    top_topics: Array<{ topic: string; count: number }>;
    recent_questions: Array<{ question: string; topic: string; timestamp: string }>;
  }>;
  total_messages: number;
}

interface AgencyData {
  agencies: Array<{
    agency: string;
    messages: number;
    unique_users: number;
    top_topics: Array<{ topic: string; count: number }>;
    daily_breakdown: Array<{ date: string; messages: number }>;
  }>;
  total_messages: number;
}

function KPICard({
  title,
  value,
  icon,
}: {
  title: string;
  value: string | number;
  icon: React.ReactNode;
}) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
              {title}
            </Typography>
            <Typography variant="h3" sx={{ mt: 0.5 }}>
              {typeof value === "number" ? value.toLocaleString() : value}
            </Typography>
          </Box>
          <Box
            sx={{
              bgcolor: "primary.light",
              borderRadius: 2,
              p: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "primary.main",
            }}
          >
            {icon}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

function DailyRow({ day }: { day: MetricsData["daily_breakdown"][0] }) {
  const [open, setOpen] = useState(false);
  const hasUsers = !!day.users && day.users.length > 0;

  return (
    <React.Fragment>
      <TableRow
        hover
        sx={{ cursor: hasUsers ? "pointer" : "default" }}
        onClick={() => hasUsers && setOpen((v) => !v)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (hasUsers && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        tabIndex={hasUsers ? 0 : undefined}
        aria-expanded={hasUsers ? open : undefined}
        aria-controls={hasUsers ? `daily-users-${day.date}` : undefined}
      >
        <TableCell width={50}>
          {hasUsers && (
            <IconButton size="small" aria-label={open ? "Collapse" : "Expand"}>
              {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell>{day.date}</TableCell>
        <TableCell align="right">{day.sessions.toLocaleString()}</TableCell>
        <TableCell align="right">{day.messages.toLocaleString()}</TableCell>
        <TableCell align="right">{day.unique_users.toLocaleString()}</TableCell>
      </TableRow>
      {hasUsers && (
        <TableRow>
          <TableCell colSpan={5} sx={{ py: 0, borderBottom: open ? undefined : "none" }}>
            <Collapse in={open} timeout={200} unmountOnExit id={`daily-users-${day.date}`}>
              <Box sx={{ py: 1, pl: 7, pr: 2, pb: 1.5 }}>
                <Table size="small" aria-label={`Users for ${day.date}`}>
                  <TableHead>
                    <TableRow>
                      <TableCell>User (Email)</TableCell>
                      <TableCell>Agency</TableCell>
                      <TableCell align="right">Sessions</TableCell>
                      <TableCell align="right">Messages</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {day.users!.map((u) => (
                      <TableRow key={u.user_id}>
                        <TableCell>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <PersonIcon fontSize="small" color="action" />
                            <Typography variant="body2">{u.display_name}</Typography>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip label={u.agency} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell align="right">{u.sessions}</TableCell>
                        <TableCell align="right">{u.messages}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </React.Fragment>
  );
}

function OverviewTab({ metrics }: { metrics: MetricsData }) {
  const daily = [...metrics.daily_breakdown].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const recentDaily = daily.slice(-30);
  const dates = recentDaily.map((d) => d.date);
  const sessions = recentDaily.map((d) => d.sessions);
  const messages = recentDaily.map((d) => d.messages);
  const users = recentDaily.map((d) => d.unique_users);

  return (
    <Box sx={{ mt: 3 }}>
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Total Users" value={metrics.unique_users} icon={<PeopleIcon />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Total Sessions" value={metrics.total_sessions} icon={<ChatIcon />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Total Messages" value={metrics.total_messages} icon={<ForumIcon />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Avg Msgs/Session" value={metrics.avg_messages_per_session} icon={<TrendingUpIcon />} />
        </Grid>
      </Grid>

      {metrics.peak_hour && metrics.peak_hour !== "N/A" && (
        <Alert icon={<AccessTimeIcon />} severity="info" sx={{ mb: 3 }}>
          Peak usage hour: <strong>{metrics.peak_hour}</strong>
        </Alert>
      )}

      {recentDaily.length > 1 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h4" gutterBottom>
              Activity Over Time
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Last 30 days
            </Typography>
            <Typography
              id="chart-activity-desc"
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Line chart: sessions, messages, and unique users per day. Each series uses a distinct color
              in the legend; the same numbers appear in the daily breakdown table below.
            </Typography>
            <Box role="group" aria-labelledby="chart-activity-desc" sx={{ width: "100%", height: 350 }}>
              <LineChart
                xAxis={[
                  {
                    data: dates.map((_, i) => i),
                    valueFormatter: (v: number) => dates[v] ?? "",
                    scaleType: "point",
                  },
                ]}
                series={[
                  { data: sessions, label: "Sessions" },
                  { data: messages, label: "Messages" },
                  { data: users, label: "Unique Users" },
                ]}
                height={320}
              />
            </Box>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h4" gutterBottom>
            Daily Breakdown
          </Typography>
          <TableContainer>
            <Table size="small" aria-label="Daily breakdown">
              <TableHead>
                <TableRow>
                  <TableCell width={50} />
                  <TableCell>Date</TableCell>
                  <TableCell align="right">Sessions</TableCell>
                  <TableCell align="right">Messages</TableCell>
                  <TableCell align="right">Unique Users</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {[...metrics.daily_breakdown]
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .map((day) => (
                    <DailyRow key={day.date} day={day} />
                  ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}

function FAQRow({ topic }: { topic: FAQData["topics"][0] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRow
        hover
        sx={{ cursor: "pointer" }}
        onClick={() => setOpen(!open)}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        tabIndex={0}
        aria-expanded={open}
        aria-controls={`faq-details-${topic.topic}`}
      >
        <TableCell>
          <IconButton size="small" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </TableCell>
        <TableCell>
          <Chip label={topic.topic} size="small" variant="outlined" />
        </TableCell>
        <TableCell align="right">
          <Typography fontWeight="bold">{topic.count}</Typography>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={3} sx={{ py: 0, borderBottom: open ? undefined : "none" }}>
          <Collapse in={open} timeout={200} unmountOnExit id={`faq-details-${topic.topic}`}>
            <Box sx={{ py: 1.5, pl: 6 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Sample questions:
              </Typography>
              {topic.sample_questions.map((q, i) => {
                const sample = typeof q === "string" ? { question: q } : q;
                const badge = [sample.display_name, sample.agency].filter(Boolean).join(" · ");
                return (
                  <Box key={i} sx={{ py: 0.3 }}>
                    <Typography variant="body2" component="span">
                      &bull; {sample.question}
                    </Typography>
                    {badge && (
                      <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                        — {badge}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function FAQTab({ faqData }: { faqData: FAQData | null }) {
  if (!faqData || faqData.topics.length === 0) {
    return (
      <Box sx={{ mt: 3, textAlign: "center", py: 8 }}>
        <Typography variant="h4" color="text.secondary">
          No FAQ data yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400, mx: "auto" }}>
          FAQ insights will appear here once users start chatting. Questions are
          automatically classified by topic.
        </Typography>
      </Box>
    );
  }

  const chartTopics = faqData.topics.slice(0, 10);

  return (
    <Box sx={{ mt: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>{faqData.total_classified}</strong> questions classified in the
        last 30 days across <strong>{faqData.topics.length}</strong> topics
      </Alert>

      {chartTopics.length > 0 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h4" gutterBottom>
              Top Topics
            </Typography>
            <Typography
              id="chart-faq-topics-desc"
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Horizontal bar chart: question count per topic. Bar color shows magnitude; exact counts are
              in the All Topics table below.
            </Typography>
            <Box role="group" aria-labelledby="chart-faq-topics-desc" sx={{ width: "100%", height: 350 }}>
              <BarChart
                yAxis={[{ data: chartTopics.map((t) => t.topic), scaleType: "band" }]}
                xAxis={[{ label: "Questions" }]}
                series={[{ data: chartTopics.map((t) => t.count), label: "Questions" }]}
                layout="horizontal"
                height={320}
                margin={{ left: 160 }}
              />
            </Box>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h4" gutterBottom>
            All Topics
          </Typography>
          <TableContainer>
            <Table size="small" aria-label="FAQ topics">
              <TableHead>
                <TableRow>
                  <TableCell width={50} />
                  <TableCell>Topic</TableCell>
                  <TableCell align="right">Count</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {faqData.topics.map((topic) => (
                  <FAQRow key={topic.topic} topic={topic} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}

function AgencyTab({ agencyData }: { agencyData: AgencyData | null }) {
  const [expandedAgency, setExpandedAgency] = useState<string | null>(null);

  if (!agencyData || agencyData.agencies.length === 0) {
    return (
      <Box sx={{ mt: 3, textAlign: "center", py: 8 }}>
        <Typography variant="h4" color="text.secondary">
          No agency data yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400, mx: "auto" }}>
          Agency analytics will appear here once users start chatting. User names
          containing an agency identifier (e.g. "A&F") are automatically parsed.
        </Typography>
      </Box>
    );
  }

  const chartAgencies = agencyData.agencies.slice(0, 10);

  return (
    <Box sx={{ mt: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>{agencyData.total_messages}</strong> messages from{" "}
        <strong>{agencyData.agencies.length}</strong> agencies in the last 30 days
      </Alert>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Agencies Active"
            value={agencyData.agencies.length}
            icon={<PeopleIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Total Messages"
            value={agencyData.total_messages}
            icon={<ForumIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Top Agency"
            value={agencyData.agencies[0]?.agency ?? "N/A"}
            icon={<TrendingUpIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Top Agency Messages"
            value={agencyData.agencies[0]?.messages ?? 0}
            icon={<ChatIcon />}
          />
        </Grid>
      </Grid>

      {chartAgencies.length > 0 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h4" gutterBottom>
              Messages by Agency
            </Typography>
            <Typography
              id="chart-agency-desc"
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Horizontal bar chart: message volume by agency. Values are also listed in the All Agencies
              table below.
            </Typography>
            <Box role="group" aria-labelledby="chart-agency-desc" sx={{ width: "100%", height: 350 }}>
              <BarChart
                yAxis={[{ data: chartAgencies.map((a) => a.agency), scaleType: "band" }]}
                xAxis={[{ label: "Messages" }]}
                series={[{ data: chartAgencies.map((a) => a.messages), label: "Messages" }]}
                layout="horizontal"
                height={320}
                margin={{ left: 160 }}
              />
            </Box>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h4" gutterBottom>
            All Agencies
          </Typography>
          <TableContainer>
            <Table size="small" aria-label="Agencies">
              <TableHead>
                <TableRow>
                  <TableCell width={50} />
                  <TableCell>Agency</TableCell>
                  <TableCell align="right">Messages</TableCell>
                  <TableCell align="right">Unique Users</TableCell>
                  <TableCell align="right">Share</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {agencyData.agencies.map((ag) => {
                  const isOpen = expandedAgency === ag.agency;
                  const share = agencyData.total_messages > 0
                    ? ((ag.messages / agencyData.total_messages) * 100).toFixed(1)
                    : "0";
                  return (
                    <React.Fragment key={ag.agency}>
                      <TableRow
                        hover
                        sx={{ cursor: "pointer" }}
                        onClick={() => setExpandedAgency(isOpen ? null : ag.agency)}
                        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedAgency(isOpen ? null : ag.agency); } }}
                        tabIndex={0}
                        aria-expanded={isOpen}
                        aria-controls={`agency-details-${ag.agency}`}
                      >
                        <TableCell>
                          <IconButton size="small" aria-label={isOpen ? "Collapse" : "Expand"}>
                            {isOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                          </IconButton>
                        </TableCell>
                        <TableCell>
                          <Chip label={ag.agency} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell align="right">
                          <Typography fontWeight="bold">{ag.messages}</Typography>
                        </TableCell>
                        <TableCell align="right">{ag.unique_users}</TableCell>
                        <TableCell align="right">{share}%</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell colSpan={5} sx={{ py: 0, borderBottom: isOpen ? undefined : "none" }}>
                          <Collapse in={isOpen} timeout={200} unmountOnExit id={`agency-details-${ag.agency}`}>
                            <Box sx={{ py: 1.5, pl: 6 }}>
                              <Typography variant="body2" color="text.secondary" gutterBottom>
                                Top topics:
                              </Typography>
                              {ag.top_topics.map((t, i) => (
                                <Typography key={i} variant="body2" sx={{ py: 0.3 }}>
                                  &bull; {t.topic} ({t.count})
                                </Typography>
                              ))}
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}

function UsersTab({ userData }: { userData: UserData | null }) {
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  if (!userData || userData.users.length === 0) {
    return (
      <Box sx={{ mt: 3, textAlign: "center", py: 8 }}>
        <Typography variant="h4" color="text.secondary">
          No user data yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400, mx: "auto" }}>
          User-level analytics will appear here once users start chatting.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>{userData.total_messages}</strong> messages from{" "}
        <strong>{userData.users.length}</strong> users in the last 30 days
      </Alert>

      <Card>
        <CardContent>
          <Typography variant="h4" gutterBottom>
            All Users
          </Typography>
          <TableContainer>
            <Table size="small" aria-label="Users">
              <TableHead>
                <TableRow>
                  <TableCell width={50} />
                  <TableCell>User</TableCell>
                  <TableCell>Agency</TableCell>
                  <TableCell align="right">Messages</TableCell>
                  <TableCell>Top Topics</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {userData.users.map((u) => {
                  const isOpen = expandedUser === u.user_id;
                  return (
                    <React.Fragment key={u.user_id}>
                      <TableRow
                        hover
                        sx={{ cursor: "pointer" }}
                        onClick={() => setExpandedUser(isOpen ? null : u.user_id)}
                        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedUser(isOpen ? null : u.user_id); } }}
                        tabIndex={0}
                        aria-expanded={isOpen}
                        aria-controls={`user-details-${u.user_id}`}
                      >
                        <TableCell>
                          <IconButton size="small" aria-label={isOpen ? "Collapse" : "Expand"}>
                            {isOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                          </IconButton>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <PersonIcon fontSize="small" color="action" />
                            <Typography variant="body2" fontWeight="bold">{u.display_name}</Typography>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip label={u.agency} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell align="right">
                          <Typography fontWeight="bold">{u.messages}</Typography>
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {u.top_topics.slice(0, 3).map((t) => (
                              <Chip key={t.topic} label={`${t.topic} (${t.count})`} size="small" variant="outlined" />
                            ))}
                          </Stack>
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell colSpan={5} sx={{ py: 0, borderBottom: isOpen ? undefined : "none" }}>
                          <Collapse in={isOpen} timeout={200} unmountOnExit id={`user-details-${u.user_id}`}>
                            <Box sx={{ py: 1.5, pl: 6 }}>
                              <Typography variant="body2" color="text.secondary" gutterBottom>
                                Recent questions:
                              </Typography>
                              {u.recent_questions.map((q, i) => (
                                <Box key={i} sx={{ py: 0.3 }}>
                                  <Typography variant="body2" component="span">
                                    &bull; {q.question}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                                    — {q.topic}
                                  </Typography>
                                </Box>
                              ))}
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  );
}

export default function MetricsPage() {
  useDocumentTitle("Analytics");
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [faqData, setFaqData] = useState<FAQData | null>(null);
  const [agencyData, setAgencyData] = useState<AgencyData | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabIndex, setTabIndex] = useState(0);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext!);

  const loadAllData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [metricsRes, faqRes, agencyRes, userRes] = await Promise.all([
        apiClient.metrics.getMetrics(),
        apiClient.metrics.getFAQInsights(30).catch(() => null),
        apiClient.metrics.getAgencyBreakdown(30).catch(() => null),
        apiClient.metrics.getUserBreakdown(30).catch(() => null),
      ]);
      setMetrics(metricsRes);
      setFaqData(faqRes);
      setAgencyData(agencyRes);
      setUserData(userRes);
    } catch (e: any) {
      setError(e.message || "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, []);

  return (
    <AdminPageLayout
      title="Analytics"
      description="Usage metrics and FAQ insights for the chatbot."
      breadcrumbLabel="Analytics"
      actions={
        <Tooltip title="Refresh data">
          <IconButton onClick={loadAllData} disabled={loading} aria-label="Refresh analytics">
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      }
    >
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Stack spacing={2}>
          <Grid container spacing={2}>
            {[1, 2, 3, 4].map((i) => (
              <Grid key={i} size={{ xs: 12, sm: 6, md: 3 }}>
                <Skeleton variant="rounded" height={100} />
              </Grid>
            ))}
          </Grid>
          <Skeleton variant="rounded" height={350} />
        </Stack>
      ) : (
        <>
          <Tabs
            value={tabIndex}
            onChange={(_, v) => setTabIndex(v)}
            sx={{ borderBottom: 1, borderColor: "divider" }}
          >
            <Tab label="Overview" />
            <Tab label="FAQ Insights" />
            <Tab label="By Agency" />
            <Tab label="By User" />
          </Tabs>
          {tabIndex === 0 && metrics && <OverviewTab metrics={metrics} />}
          {tabIndex === 1 && <FAQTab faqData={faqData} />}
          {tabIndex === 2 && <AgencyTab agencyData={agencyData} />}
          {tabIndex === 3 && <UsersTab userData={userData} />}
        </>
      )}
    </AdminPageLayout>
  );
}
