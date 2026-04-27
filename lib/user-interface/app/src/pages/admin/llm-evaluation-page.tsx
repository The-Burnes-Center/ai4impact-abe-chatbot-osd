import { Tabs, Tab, Box } from "@mui/material";
import { useNavigate, useLocation } from "react-router-dom";
import CurrentEvalTab from "./current-eval-tab";
import NewEvalTab from "./new-eval-tab";
import PastEvalsTab from "./past-evals-tab";
import TestLibraryTab from "./test-library-tab";
import { useState, useEffect } from "react";
import AdminPageLayout from "../../components/admin-page-layout";
import { useDocumentTitle } from "../../common/hooks/use-document-title";

const TAB_IDS = ["dashboard", "run", "history", "library"];

export default function LlmEvaluationPage() {
  useDocumentTitle("Admin \u00b7 LLM evaluation");
  const [activeTab, setActiveTab] = useState(0);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const hash = location.hash.replace("#", "");
    const tabIndex = TAB_IDS.indexOf(hash);
    if (tabIndex >= 0) {
      setActiveTab(tabIndex);
    } else if (!location.hash) {
      navigate(`/admin/llm-evaluation#dashboard`, { replace: true });
    }
  }, [location, navigate]);

  const handleTabChange = (tabIndex: number) => {
    setActiveTab(tabIndex);
    navigate(`/admin/llm-evaluation#${TAB_IDS[tabIndex]}`, { replace: true });
  };

  return (
    <AdminPageLayout
      title="Quality Monitoring"
      description="Monitor, test, and curate your chatbot's response quality."
      breadcrumbLabel="Quality Monitoring"
    >
      <Box>
        <Tabs
          value={activeTab}
          onChange={(_, newValue) => handleTabChange(newValue)}
          aria-label="Quality monitoring sections"
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Dashboard" id="llm-eval-tab-0" aria-controls="llm-eval-tabpanel-0" />
          <Tab label="Run Evaluation" id="llm-eval-tab-1" aria-controls="llm-eval-tabpanel-1" />
          <Tab label="History" id="llm-eval-tab-2" aria-controls="llm-eval-tabpanel-2" />
          <Tab label="Test Library" id="llm-eval-tab-3" aria-controls="llm-eval-tabpanel-3" />
        </Tabs>
        <Box sx={{ pt: 2 }}>
          {activeTab === 0 && (
            <Box role="tabpanel" id="llm-eval-tabpanel-0" aria-labelledby="llm-eval-tab-0">
              <CurrentEvalTab
                onRunEval={() => handleTabChange(1)}
                onViewLibrary={() => handleTabChange(3)}
              />
            </Box>
          )}
          {activeTab === 1 && (
            <Box role="tabpanel" id="llm-eval-tabpanel-1" aria-labelledby="llm-eval-tab-1">
              <NewEvalTab onComplete={() => handleTabChange(2)} />
            </Box>
          )}
          {activeTab === 2 && (
            <Box role="tabpanel" id="llm-eval-tabpanel-2" aria-labelledby="llm-eval-tab-2">
              <PastEvalsTab />
            </Box>
          )}
          {activeTab === 3 && (
            <Box role="tabpanel" id="llm-eval-tabpanel-3" aria-labelledby="llm-eval-tab-3">
              <TestLibraryTab />
            </Box>
          )}
        </Box>
      </Box>
    </AdminPageLayout>
  );
}
