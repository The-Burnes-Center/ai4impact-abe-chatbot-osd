import { useState, useEffect, useContext } from "react";
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
import { LineChart } from "@mui/x-charts/LineChart";
import { BarChart } from "@mui/x-charts/BarChart";
import AdminPageLayout from "../../components/admin-page-layout";

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
  }>;
}

interface FAQData {
  topics: Array<{
    topic: string;
    count: number;
    sample_questions: string[];
  }>;
  total_classified: number;
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
            <Box sx={{ width: "100%", height: 350 }}>
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
            <Table size="small">
              <TableHead>
                <TableRow>
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
                    <TableRow key={day.date} hover>
                      <TableCell>{day.date}</TableCell>
                      <TableCell align="right">{day.sessions.toLocaleString()}</TableCell>
                      <TableCell align="right">{day.messages.toLocaleString()}</TableCell>
                      <TableCell align="right">{day.unique_users.toLocaleString()}</TableCell>
                    </TableRow>
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
        aria-expanded={open}
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
          <Collapse in={open} timeout={200} unmountOnExit>
            <Box sx={{ py: 1.5, pl: 6 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Sample questions:
              </Typography>
              {topic.sample_questions.map((q, i) => (
                <Typography key={i} variant="body2" sx={{ py: 0.3 }}>
                  &bull; {q}
                </Typography>
              ))}
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
            <Box sx={{ width: "100%", height: 350 }}>
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
            <Table size="small">
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

export default function MetricsPage() {
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [faqData, setFaqData] = useState<FAQData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabIndex, setTabIndex] = useState(0);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);

  const loadAllData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [metricsRes, faqRes] = await Promise.all([
        apiClient.metrics.getMetrics(),
        apiClient.metrics.getFAQInsights(30).catch(() => null),
      ]);
      setMetrics(metricsRes);
      setFaqData(faqRes);
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
          </Tabs>
          {tabIndex === 0 && metrics && <OverviewTab metrics={metrics} />}
          {tabIndex === 1 && <FAQTab faqData={faqData} />}
        </>
      )}
    </AdminPageLayout>
  );
}
