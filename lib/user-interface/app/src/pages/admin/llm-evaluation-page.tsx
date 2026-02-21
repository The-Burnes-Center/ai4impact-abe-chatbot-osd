import { Tabs, Tab, Box } from "@mui/material";
import { useNavigate, useLocation } from "react-router-dom";
import CurrentEvalTab from "./current-eval-tab";
import NewEvalTab from "./new-eval-tab.tsx";
import PastEvalsTab from "./past-evals-tab.tsx";
import TestCasesTab from "./test-cases-tab.tsx";
import { useState, useEffect } from "react";
import AdminPageLayout from "../../components/admin-page-layout";

const TAB_IDS = ["current-eval", "past-evals", "add-test-cases", "new-eval"];

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
      navigate(`/admin/llm-evaluation#current-eval`, { replace: true });
    }
  }, [location, navigate]);

  const handleTabChange = (tabIndex: number) => {
    setActiveTab(tabIndex);
    navigate(`/admin/llm-evaluation#${TAB_IDS[tabIndex]}`, { replace: true });
  };

  return (
    <AdminPageLayout
      title="LLM Evaluation"
      description="Evaluate and track the performance of the AI system."
      breadcrumbLabel="LLM Evaluation"
    >
      <Box>
        <Tabs
          value={activeTab}
          onChange={(_, newValue) => handleTabChange(newValue)}
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Current Evaluation" />
          <Tab label="Past Evaluations" />
          <Tab label="Add Test Cases" />
          <Tab label="New Evaluation" />
        </Tabs>
        <Box sx={{ pt: 2 }}>
          {activeTab === 0 && (
            <CurrentEvalTab
              tabChangeFunction={() => handleTabChange(0)}
              addTestCasesHandler={() => handleTabChange(2)}
              newEvalHandler={() => handleTabChange(3)}
            />
          )}
          {activeTab === 1 && (
            <PastEvalsTab
              tabChangeFunction={() => handleTabChange(1)}
              documentType="evaluationSummary"
            />
          )}
          {activeTab === 2 && (
            <TestCasesTab tabChangeFunction={() => handleTabChange(2)} />
          )}
          {activeTab === 3 && (
            <NewEvalTab
              tabChangeFunction={() => handleTabChange(3)}
              documentType="file"
            />
          )}
        </Box>
      </Box>
    </AdminPageLayout>
  );
}
