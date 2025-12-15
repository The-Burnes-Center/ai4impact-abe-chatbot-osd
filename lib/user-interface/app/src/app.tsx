import React, { useContext } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { AppContext } from "./common/app-context";
import GlobalHeader from "./components/global-header";
import Playground from "./pages/chatbot/playground/playground";
import SessionPage from "./pages/chatbot/sessions/sessions";
import DataPage from "./pages/admin/data-view-page";
import MetricsPage from "./pages/admin/metrics-page";
import UserFeedbackPage from "./pages/admin/user-feedback-page";
import UserFeedbackDetailPage from "./pages/admin/feedback-details";
import AboutChatbot from "./pages/help/about-chatbot";
import Support from "./pages/help/support";
import HowToUse from "./pages/help/how-to-use";
import LandingPage from "./pages/landing-page";
import LandingPageInfo from "./pages/landing-page-info";
import LandingPageStart from "./pages/landing-page-start";
import TipsAndQuestions from "./pages/tips-and-questions";
import LlmEvaluationPage from "./pages/admin/llm-evaluation-page"; 
import DetailedEvaluationPage from "./pages/admin/detailed-evaluation-page";
import { v4 as uuidv4 } from "uuid";
import "./styles/app.scss";

function App() {
  const appContext = useContext(AppContext);

  return (
    <div style={{ height: "100%" }}>
      <BrowserRouter>
        <Routes>
          {/* Landing Page */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/about" element={<LandingPageInfo />} />
          <Route path="/get-started" element={<LandingPageStart />} />

          {/* Grouped Routes with Global Header */}
          <Route
            element={
              <>
                <GlobalHeader />
                <div style={{ height: "56px", backgroundColor: "#000716" }}>&nbsp;</div>
                <Outlet /> {/* Ensure Outlet renders child routes */}
              </>
            }
          >
            {/* Chatbot Routes */}
            <Route path="/chatbot">
              <Route path="playground/:sessionId" element={<Playground />} />
              <Route path="sessions" element={<SessionPage />} />
              <Route path="tips" element={<TipsAndQuestions />} />
            </Route>

            {/* Admin Routes */}
            <Route path="/admin">
              <Route path="data" element={<DataPage />} />
              <Route path="metrics" element={<MetricsPage />} />
              <Route path="user-feedback" element={<UserFeedbackPage />} />
              <Route path="user-feedback/:feedbackId" element={<UserFeedbackDetailPage />} />
              <Route path="llm-evaluation" element={<Outlet />}>
                <Route index element={<LlmEvaluationPage />} />
                {/* Support both URL formats for backward compatibility */}
                <Route
                  path=":evaluationId"
                  element={
                    <DetailedEvaluationPage
                      documentType="detailedEvaluation" 
                    />
                  }
                />
                <Route
                  path="details/:evaluationId"
                  element={
                    <DetailedEvaluationPage
                      documentType="detailedEvaluation" 
                    />
                  }
                />
              </Route>
            </Route>

            {/* FAQ and Guide Routes */}
            <Route path="/faq-and-guide">
              <Route path="about-chatbot" element={<AboutChatbot />} />
              <Route path="how-to-use" element={<HowToUse />} />
              <Route path="support" element={<Support />} />
            </Route>
          </Route>

          {/* Catch-all Route */}
          <Route
            path="*"
            element={<Navigate to={`/chatbot/playground/${uuidv4()}`} replace />}
          />
        </Routes>
      </BrowserRouter>
    </div>
  );
}

export default App;
