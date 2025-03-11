import {
    BreadcrumbGroup,
    ContentLayout,
    Header,
    SpaceBetween,
    Alert,
    Tabs,
    Container
  } from "@cloudscape-design/components";
  import useOnFollow from "../../common/hooks/use-on-follow";
  import BaseAppLayout from "../../components/base-app-layout";
  import CurrentEvalTab from "./current-eval-tab";
  import NewEvalTab from "./new-eval-tab.tsx";
  import PastEvalsTab from "./past-evals-tab.tsx";
  import TestCasesTab from "./test-cases-tab.tsx";
  import { CHATBOT_NAME } from "../../common/constants";
  import { useState, useEffect, useContext } from "react";
  import { Auth } from "aws-amplify";
  import { ApiClient } from "../../common/api-client/api-client";
  import { AppContext } from "../../common/app-context";
  import { useNavigate, useLocation } from "react-router-dom";

  export default function LlmEvaluationPage() {
    const onFollow = useOnFollow();
    const [admin, setAdmin] = useState<boolean>(false);
    const [activeTab, setActiveTab] = useState("current-eval");
    const appContext = useContext(AppContext);
    const apiClient = new ApiClient(appContext);
    const [lastSyncTime, setLastSyncTime] = useState("")
    const [showUnsyncedAlert, setShowUnsyncedAlert] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();

    /** Function to get the last synced time */
    const refreshSyncTime = async () => {
      try {
        const lastSync = await apiClient.knowledgeManagement.lastKendraSync();    
        setLastSyncTime(lastSync);
      } catch (e) {
        console.log(e);
      }
    }

  // fix broken aria menu
  useEffect(() => {
    const fixAriaMenus = () => {
      const problematicMenus = document.querySelectorAll('ul.awsui_options-list_19gcf_1hl2l_141');
  
      problematicMenus.forEach((menu) => {
        if (menu.getAttribute('role') === 'menu') {
          menu.removeAttribute('role');
        }
      });
    };
  
    // runs this initally
    fixAriaMenus();
  
    const observer = new MutationObserver(() => {
      fixAriaMenus();
    });
  
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  
    return () => {
      observer.disconnect();
    };
  }, []);

  // Set active tab based on URL hash on component mount
  useEffect(() => {
    const hash = location.hash.replace('#', '');
    if (hash === 'current-eval' || hash === 'past-evals' || hash === 'add-test-cases' || hash === 'new-eval') {
      setActiveTab(hash);
    } else if (!location.hash) {
      // If no hash, set the URL to include the default tab
      navigate(`/admin/llm-evaluation#current-eval`, { replace: true });
    }
  }, [location, navigate]);
      
    /** Checks for admin status */
    useEffect(() => {
      (async () => {
        try {
          const result = await Auth.currentAuthenticatedUser();
          if (!result || Object.keys(result).length === 0) {
            console.log("Signed out!")
            Auth.signOut();
            return;
          }
          const admin = result?.signInUserSession?.idToken?.payload["custom:role"]
          if (admin) {
            const data = JSON.parse(admin);
            if (data.includes("Admin")) {
              setAdmin(true);
            }
          }
        }
        /** If there is some issue checking for admin status, just do nothing and the
         * error page will show up
          */
        catch (e) {
          console.log(e);
        }
      })();
    }, []);

    /** Handler for tab changes to update URL */
    const handleTabChange = (tabId) => {
      setActiveTab(tabId);
      // Use replace:true to avoid adding to browser history stack
      navigate(`/admin/llm-evaluation#${tabId}`, { replace: true });
    };

    // Create direct tab change handlers for each tab to avoid nested function issues
    const handleCurrentEvalTab = () => handleTabChange("current-eval");
    const handlePastEvalsTab = () => handleTabChange("past-evals");
    const handleAddTestCasesTab = () => handleTabChange("add-test-cases");
    const handleNewEvalTab = () => handleTabChange("new-eval");

    /** If the admin status check fails, just show an access denied page*/
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
                href: "/",
              },
              {
                text: "View Data",
                href: "/admin/llm-evaluation",
              },
            ]}
          />
        }
        content={
          <ContentLayout
            header={
              <Header
                variant="h1"
              >
                Llm Evaluation Dashboard
              </Header>
            }
          >
            <SpaceBetween size="l">
              <Container
                header={
                  <Header
                    variant="h3"
                    // description="Container description"
                  >
                    Giving Insight Into The Performance of Our AI System
                  </Header>                
                }
              >
                <SpaceBetween size="xxs">
                Look at evaluation trends, performance on individual test cases, or create new evaluation instances with dynamic sets of test cases.

                <br></br>

                </SpaceBetween>
              </Container>
              <Tabs
                tabs={[
                    {
                    label: "Current Evaluation",
                    id: "current-eval",
                    content: (
                        <CurrentEvalTab
                        tabChangeFunction={handleCurrentEvalTab}
                        addTestCasesHandler={handleAddTestCasesTab}
                        newEvalHandler={handleNewEvalTab}
                        />
                    ),
                    },
                    {
                    label: "Past Evaluations",
                    id: "past-evals",
                    content: (
                      <PastEvalsTab 
                        tabChangeFunction={handlePastEvalsTab}
                        documentType="evaluationSummary"
                      />
                    ),
                    },
                    {
                    label: "Add Test Cases",
                    id: "add-test-cases",
                    content: (
                        <TestCasesTab 
                        tabChangeFunction={handleAddTestCasesTab}
                        />
                    ),
                    },
                    { 
                      label: "New Evaluation",
                      id: "new-eval",
                      content: (
                          <NewEvalTab 
                          tabChangeFunction={handleNewEvalTab}
                          documentType="file"
                          />
                      ),
                      },
                ]}
                activeTabId={activeTab}
                onChange={({ detail: { activeTabId } }) => {
                    handleTabChange(activeTabId);
                }}
                />

            </SpaceBetween>
          </ContentLayout>
        }
      />
    );
  }