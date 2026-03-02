import { Tabs, Tab, Box } from "@mui/material";
import { useNavigate, useLocation } from "react-router-dom";
import CurrentEvalTab from "./current-eval-tab";
import NewEvalTab from "./new-eval-tab";
import PastEvalsTab from "./past-evals-tab";
import TestLibraryTab from "./test-library-tab";
import { useState, useEffect } from "react";
import AdminPageLayout from "../../components/admin-page-layout";

const TAB_IDS = ["dashboard", "run", "history", "library"];

export default function LlmEvaluationPage() {
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
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Dashboard" />
          <Tab label="Run Evaluation" />
          <Tab label="History" />
          <Tab label="Test Library" />
        </Tabs>
        <Box sx={{ pt: 2 }}>
          {activeTab === 0 && (
            <CurrentEvalTab
              onRunEval={() => handleTabChange(1)}
              onViewLibrary={() => handleTabChange(3)}
            />
          )}
          {activeTab === 1 && (
            <NewEvalTab onComplete={() => handleTabChange(2)} />
          )}
          {activeTab === 2 && <PastEvalsTab />}
          {activeTab === 3 && <TestLibraryTab />}
        </Box>
      </Box>
    </AdminPageLayout>
  );
}
