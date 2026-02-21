import React, { Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import BaseAppLayout from "./components/base-app-layout";
import ErrorBoundary from "./components/error-boundary";
import { v4 as uuidv4 } from "uuid";
import "./styles/app.scss";

const Playground = React.lazy(() => import("./pages/chatbot/playground/playground"));
const SessionPage = React.lazy(() => import("./pages/chatbot/sessions/sessions"));
const TipsAndQuestions = React.lazy(() => import("./pages/tips-and-questions"));
const DataPage = React.lazy(() => import("./pages/admin/data-view-page"));
const UserFeedbackPage = React.lazy(() => import("./pages/admin/user-feedback-page"));
const UserFeedbackDetailPage = React.lazy(() => import("./pages/admin/feedback-details"));
const MetricsPage = React.lazy(() => import("./pages/admin/metrics-page"));
const LlmEvaluationPage = React.lazy(() => import("./pages/admin/llm-evaluation-page"));
const DetailedEvaluationPage = React.lazy(() => import("./pages/admin/detailed-evaluation-page"));
const AboutChatbot = React.lazy(() => import("./pages/help/about-chatbot"));
const Support = React.lazy(() => import("./pages/help/support"));
const HowToUse = React.lazy(() => import("./pages/help/how-to-use"));
const LandingPage = React.lazy(() => import("./pages/landing-page"));
const LandingPageInfo = React.lazy(() => import("./pages/landing-page-info"));
const LandingPageStart = React.lazy(() => import("./pages/landing-page-start"));

function PageLoader() {
  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: 200,
        gap: 1,
        color: "text.secondary",
      }}
    >
      <CircularProgress size={20} />
      Loading...
    </Box>
  );
}

function AppShell() {
  return (
    <BaseAppLayout>
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </BaseAppLayout>
  );
}

function App() {
  return (
    <div style={{ height: "100%" }}>
      <BrowserRouter>
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* Landing Pages (no sidebar) */}
              <Route path="/" element={<LandingPage />} />
              <Route path="/about" element={<LandingPageInfo />} />
              <Route path="/get-started" element={<LandingPageStart />} />

              {/* App routes with sidebar + header */}
              <Route element={<AppShell />}>
                <Route path="/chatbot">
                  <Route path="playground/:sessionId" element={<Playground />} />
                  <Route path="sessions" element={<SessionPage />} />
                  <Route path="tips" element={<TipsAndQuestions />} />
                </Route>

                <Route path="/admin">
                  <Route path="data" element={<DataPage />} />
                  <Route path="user-feedback" element={<UserFeedbackPage />} />
                  <Route path="user-feedback/:feedbackId" element={<UserFeedbackDetailPage />} />
                  <Route path="metrics" element={<MetricsPage />} />
                  <Route path="llm-evaluation" element={<Outlet />}>
                    <Route index element={<LlmEvaluationPage />} />
                    <Route
                      path=":evaluationId"
                      element={<DetailedEvaluationPage documentType="detailedEvaluation" />}
                    />
                    <Route
                      path="details/:evaluationId"
                      element={<DetailedEvaluationPage documentType="detailedEvaluation" />}
                    />
                  </Route>
                </Route>

                <Route path="/faq-and-guide">
                  <Route path="about-chatbot" element={<AboutChatbot />} />
                  <Route path="how-to-use" element={<HowToUse />} />
                  <Route path="support" element={<Support />} />
                </Route>
              </Route>

              {/* Catch-all */}
              <Route
                path="*"
                element={<Navigate to={`/chatbot/playground/${uuidv4()}`} replace />}
              />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
    </div>
  );
}

export default App;
