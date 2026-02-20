import {
  BreadcrumbGroup,
  ContentLayout,
  Header,
  SpaceBetween,
  Alert,
  Container,
  Box,
  ColumnLayout,
  Spinner,
  Button
} from "@cloudscape-design/components";
import useOnFollow from "../../common/hooks/use-on-follow";
import BaseAppLayout from "../../components/base-app-layout";
import { CHATBOT_NAME } from "../../common/constants";
import { useState, useEffect, useContext } from "react";
import { Auth } from "aws-amplify";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";

interface MetricsData {
  unique_users: number;
  total_sessions: number;
  total_messages: number;
  daily_breakdown: Array<{
    date: string;
    sessions: number;
    messages: number;
    unique_users: number;
  }>;
}

export default function MetricsPage() {
  const onFollow = useOnFollow();
  const [admin, setAdmin] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);

  /** Checks for admin status */
  useEffect(() => {
    (async () => {
      try {
        const result = await Auth.currentAuthenticatedUser();
        if (!result || Object.keys(result).length === 0) {
          console.log("Signed out!");
          Auth.signOut();
          return;
        }
        const adminRole = result?.signInUserSession?.idToken?.payload["custom:role"];
        if (adminRole) {
          const data = JSON.parse(adminRole);
          if (data.some((role: string) => role.includes("Admin"))) {
            setAdmin(true);
            loadMetrics();
          }
        }
      } catch (e) {
        console.log(e);
      }
    })();
  }, []);

  const loadMetrics = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiClient.metrics.getMetrics();
      setMetrics(data);
    } catch (e: any) {
      console.error("Error loading metrics:", e);
      setError(e.message || "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  };

  /** If the admin status check fails, show access denied page */
  if (!admin) {
    return (
      <div
        style={{
          height: "90vh",
          width: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Alert header="Configuration error" type="error">
          You are not authorized to view this page!
        </Alert>
      </div>
    );
  }

  return (
    <BaseAppLayout
      contentType="cards"
      breadcrumbs={
        <BreadcrumbGroup
          onFollow={onFollow}
          items={[
            {
              text: CHATBOT_NAME,
              href: "/*",
            },
            {
              text: "Metrics",
              href: "/admin/metrics",
            },
          ]}
        />
      }
      content={
        <ContentLayout
          header={
            <Header
              variant="h1"
              actions={
                <Button onClick={loadMetrics} disabled={loading} iconName="refresh">
                  Refresh
                </Button>
              }
            >
              Metrics Dashboard
            </Header>
          }
        >
          <SpaceBetween size="l">
            {loading && (
              <Box textAlign="center" padding="xl">
                <Spinner />
              </Box>
            )}

            {error && (
              <Alert type="error" dismissible onDismiss={() => setError(null)}>
                {error}
              </Alert>
            )}

            {metrics && !loading && (
              <>
                <ColumnLayout columns={3}>
                  <Container header={<Header variant="h2">Total Users</Header>}>
                    <Box fontSize="display-l" fontWeight="bold" textAlign="center" padding="xl">
                      {metrics.unique_users.toLocaleString()}
                    </Box>
                  </Container>
                  <Container header={<Header variant="h2">Total Sessions</Header>}>
                    <Box fontSize="display-l" fontWeight="bold" textAlign="center" padding="xl">
                      {metrics.total_sessions.toLocaleString()}
                    </Box>
                  </Container>
                  <Container header={<Header variant="h2">Total Messages</Header>}>
                    <Box fontSize="display-l" fontWeight="bold" textAlign="center" padding="xl">
                      {metrics.total_messages.toLocaleString()}
                    </Box>
                  </Container>
                </ColumnLayout>

                <Container header={<Header variant="h2">Daily Breakdown</Header>}>
                  <SpaceBetween size="s">
                    {metrics.daily_breakdown.length === 0 ? (
                      <Box textAlign="center" padding="l">
                        No data available
                      </Box>
                    ) : (
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ borderBottom: "2px solid #e9ebed" }}>
                            <th style={{ textAlign: "left", padding: "12px", fontWeight: "bold" }}>Date</th>
                            <th style={{ textAlign: "right", padding: "12px", fontWeight: "bold" }}>Sessions</th>
                            <th style={{ textAlign: "right", padding: "12px", fontWeight: "bold" }}>Messages</th>
                            <th style={{ textAlign: "right", padding: "12px", fontWeight: "bold" }}>Unique Users</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...metrics.daily_breakdown].sort((a, b) => a.date.localeCompare(b.date)).map((day, index) => (
                            <tr key={day.date} style={{ borderBottom: index < metrics.daily_breakdown.length - 1 ? "1px solid #e9ebed" : "none" }}>
                              <td style={{ padding: "12px" }}>{day.date}</td>
                              <td style={{ textAlign: "right", padding: "12px" }}>
                                {day.sessions.toLocaleString()}
                              </td>
                              <td style={{ textAlign: "right", padding: "12px" }}>
                                {day.messages.toLocaleString()}
                              </td>
                              <td style={{ textAlign: "right", padding: "12px" }}>
                                {day.unique_users.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </SpaceBetween>
                </Container>
              </>
            )}
          </SpaceBetween>
        </ContentLayout>
      }
    />
  );
}

