import {
  BreadcrumbGroup,
  ContentLayout,
  Header,
  SpaceBetween,
  Alert,
  Container,
  Box,
  LineChart,
} from "@cloudscape-design/components";
import useOnFollow from "../../common/hooks/use-on-follow";
import BaseAppLayout from "../../components/base-app-layout";
import { CHATBOT_NAME } from "../../common/constants";
import { useState, useEffect, useContext, useMemo } from "react";
import { Auth } from "aws-amplify";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";

export default function MetricsPage() {
  const onFollow = useOnFollow();
  const [admin, setAdmin] = useState<boolean>(false);
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const [loading, setLoading] = useState(true);
  const [totalUsers, setTotalUsers] = useState<number>(0);
  const [trafficData, setTrafficData] = useState<Array<{x: number, y: number}>>([]);

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
        const admin = result?.signInUserSession?.idToken?.payload["custom:role"];
        if (admin) {
          const data = JSON.parse(admin);
          if (data.some((role: string) => role.includes("Admin"))) {
            setAdmin(true);
          }
        }
      } catch (e) {
        console.log(e);
      }
    })();
  }, []);

  /** Load metrics data */
  useEffect(() => {
    if (!admin || !appContext) return;

    const loadMetrics = async () => {
      setLoading(true);
      try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
        
        const startDateStr = startDate.toISOString().split('T')[0];
        const endDateStr = endDate.toISOString().split('T')[0];

        const loginChartData = await apiClient.metrics.getDailyLogins(startDateStr, endDateStr);
        
        const transformedLoginData = loginChartData.map((item: {x: string, y: number}) => ({
          x: new Date(item.x).getTime(),
          y: item.y
        }));

        const totalLoginCount = loginChartData.reduce((sum: number, item: {x: string, y: number}) => sum + item.y, 0);
        setTotalUsers(totalLoginCount);

        const chatbotUseData = await apiClient.metrics.getChatbotUse(
          startDate.toISOString(),
          endDate.toISOString()
        );

        if (chatbotUseData && chatbotUseData.Items) {
          const trafficByDate: {[key: string]: number} = {};
          
          chatbotUseData.Items.forEach((item: any) => {
            const date = new Date(item.Timestamp).toISOString().split('T')[0];
            trafficByDate[date] = (trafficByDate[date] || 0) + 1;
          });

          const transformedTrafficData = Object.entries(trafficByDate)
            .map(([date, count]) => ({
              x: new Date(date).getTime(),
              y: count as number
            }))
            .sort((a, b) => a.x - b.x);

          setTrafficData(transformedTrafficData);
        }

      } catch (error) {
        console.error("Error loading metrics:", error);
      } finally {
        setLoading(false);
      }
    };

    loadMetrics();
  }, [admin, appContext, apiClient]);

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
            <Header variant="h1">Metrics Dashboard</Header>
          }
        >
          <SpaceBetween size="l">
            <Container header={<Header variant="h3">Number of Users</Header>}>
              <Box fontSize="display-l" fontWeight="bold">
                {loading ? "Loading..." : totalUsers.toLocaleString()}
              </Box>
            </Container>

            <Container header={<Header variant="h3">Traffic Chart</Header>}>
              {loading ? (
                <Box textAlign="center" padding="xl">
                  Loading chart data...
                </Box>
              ) : trafficData.length > 0 ? (
                <LineChart
                  series={[
                    {
                      title: "Daily Interactions",
                      type: "line",
                      data: trafficData,
                    },
                  ]}
                  xDomain={
                    trafficData.length > 0
                      ? [
                          Math.min(...trafficData.map((d) => d.x)),
                          Math.max(...trafficData.map((d) => d.x)),
                        ]
                      : [0, 1]
                  }
                  yDomain={
                    trafficData.length > 0
                      ? [0, Math.max(...trafficData.map((d) => d.y)) * 1.1]
                      : [0, 1]
                  }
                  i18nStrings={{
                    legendAriaLabel: "Legend",
                    chartAriaRoleDescription: "line chart",
                    xTickFormatter: (value) =>
                      new Date(value)
                        .toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        }),
                    yTickFormatter: (value) => `${Math.round(value)}`,
                  }}
                  ariaLabel="Traffic over time"
                />
              ) : (
                <Box textAlign="center" padding="xl">
                  No traffic data available
                </Box>
              )}
            </Container>
          </SpaceBetween>
        </ContentLayout>
      }
    />
  );
}

