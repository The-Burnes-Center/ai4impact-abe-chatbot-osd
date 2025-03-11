import {
    BreadcrumbGroup,
    ContentLayout,
    Header,
    SpaceBetween,
    Container,
    Alert,
    ProgressBar,
    Grid,
    LineChart,
  } from "@cloudscape-design/components";
  import { Authenticator, Heading, useTheme } from "@aws-amplify/ui-react";
  import { Utils } from "../../common/utils";
  import useOnFollow from "../../common/hooks/use-on-follow";
  import FeedbackTab from "./feedback-tab";
  import FeedbackPanel from "../../components/feedback-panel";
  import { CHATBOT_NAME } from "../../common/constants";
  import { getColumnDefinition } from "./columns";
  import { useCollection } from "@cloudscape-design/collection-hooks";
  import { useState, useEffect, useMemo, useContext, useCallback, useRef } from "react";
  import { useNotifications } from "../../components/notif-manager";
  import { Auth } from "aws-amplify";
  import { ApiClient } from "../../common/api-client/api-client"; 
  import { AppContext } from "../../common/app-context";
  
  // Add CSS for loading animation
  const loadingAnimationStyle = `
    @keyframes loading {
      0% {
        left: -30%;
      }
      100% {
        left: 100%;
      }
    }
  `;
  
  export interface CurrentEvalTabProps {
    tabChangeFunction: () => void;
    addTestCasesHandler?: () => void;
    newEvalHandler?: () => void;
  }
  
  
  export default function CurrentEvalTab(props: CurrentEvalTabProps) {
    const appContext = useContext(AppContext)
    const onFollow = useOnFollow();
    const { tokens } = useTheme();
    const [metrics, setMetrics] = useState<any>({});
    const [admin, setAdmin] = useState<boolean>(false);
    const apiClient = useMemo(() => new ApiClient(appContext), [appContext])
    const [currentPageIndex, setCurrentPageIndex] = useState(1);
    const [evaluations, setEvaluations] = useState([]);
    const [loading, setLoading] = useState(true);
    const { addNotification } = useNotifications();
    const needsRefresh = useRef(false);
    const [pages, setPages] = useState([]);
    const [error, setError] = useState<string | null>(null);
  
    const { items, collectionProps, paginationProps } = useCollection(evaluations, {
      pagination: { pageSize: 10 },
      sorting: {
        defaultState: {
          sortingColumn: {
            sortingField: "timestamp",
          },
          isDescending: true,
        },
      },
    });
  
  
    const getEvaluations = useCallback(async () => {
      setLoading(true);
      setError(null); // Clear any previous errors when starting a new fetch
      
      try {
        console.log("Fetching evaluation summaries...");
        const result = await apiClient.evaluations.getEvaluationSummaries();
        console.log("Evaluation result:", result);
  
        // Check if there's an error in the result
        if (result.error) {
          console.error("Error from API:", result.error);
          setError(result.error);
          setEvaluations([]);
          setLoading(false);
          return;
        }
        
        // Check if result exists and has Items property
        if (result && result.Items && result.Items.length > 0) {
          console.log("Found evaluation items:", result.Items.length);
          // Take only the first 10 evaluations
          const firstTenEvaluations = result.Items.slice(0, 10);
          // Update state with just these evaluations
          setEvaluations(firstTenEvaluations);
          
          // Clear any previous errors
          setError(null);
        } else {
          // No evaluations found, but API call succeeded
          console.log("No evaluations found or empty response");
          setEvaluations([]);
          setError("No evaluations found. You can create a new evaluation by uploading test cases and running an evaluation.");
        }
      } catch (error) {
        console.error("Error fetching evaluations:", error);
        const errorMessage = error?.message || "Unknown error";
        console.error("Error details:", errorMessage);
        setError(`Failed to load evaluations: ${errorMessage}`);
        setEvaluations([]);
      } finally {
        setLoading(false);
      }
    }, [apiClient.evaluations]);
  
  // Helper for manual refresh with visual feedback
  const refreshEvaluations = async () => {
    setLoading(true);
    await getEvaluations();
  };
  
  // add text to dropdown
  useEffect(() => {
    const addAriaLabelToButton = () => {
      // Selects all buttons within the parent container
      const buttons = document.querySelectorAll('div.awsui_child_18582_1wlz1_145 button');
  
      buttons.forEach((button) => {
        if (!button.hasAttribute('aria-label')) {
          console.log('Button found, adding aria-label');
          button.setAttribute('aria-label', 'Open dropdown');
        }
      });
    };
  
    // initial run
    addAriaLabelToButton();
  
    const observer = new MutationObserver(() => {
      addAriaLabelToButton();
    });
  
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  
    return () => observer.disconnect();
  }, []);
  
  
  useEffect(() => {
    getEvaluations();
  }, [getEvaluations]);
  
    useEffect(() => {
      (async () => {
        const result = await Auth.currentAuthenticatedUser();
        if (!result || Object.keys(result).length === 0) {
          console.log("Signed out!")
          Auth.signOut();
          return;
        }
  
        try {
          const result = await Auth.currentAuthenticatedUser();
          const admin = result?.signInUserSession?.idToken?.payload["custom:role"];
          if (admin) {
            const data = JSON.parse(admin);
            if (data.includes("Admin")) {
              setAdmin(true);
            }
          }
        }
        catch (e){
          console.log(e);
        }
      })();
    }, []);
  
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
  
    if (loading) {
      return (
        <Container header={<Header variant="h2">Loading Evaluations</Header>}>
          <style>{loadingAnimationStyle}</style>
          <SpaceBetween size="l">
            <div style={{ padding: "20px", textAlign: "center" }}>
              <div style={{ marginBottom: "20px" }}>
                <div style={{ 
                  width: "100%", 
                  height: "4px", 
                  backgroundColor: "#eaeded",
                  borderRadius: "4px",
                  overflow: "hidden",
                  position: "relative"
                }}>
                  <div style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    height: "100%",
                    width: "30%",
                    backgroundColor: "#0972d3",
                    animation: "loading 1.5s infinite ease-in-out",
                    borderRadius: "4px"
                  }}></div>
                </div>
              </div>
              <p>Fetching evaluation data...</p>
            </div>
          </SpaceBetween>
        </Container>
      );
    }
  
    if (items.length === 0) {
      console.log("items: ", items);
      return (
        <Container header={<Header variant="h2">No Evaluations Found</Header>}>
          <SpaceBetween size="l">
            <Alert
              type={error ? "error" : "info"}
              header={error ? "Error loading evaluation data" : "No evaluation data available"}
              action={
                <button
                  onClick={refreshEvaluations}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: error ? '#d13212' : '#0972d3',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: 'bold',
                  }}
                >
                  Retry
                </button>
              }
            >
              {error ? (
                <div>
                  <p>{error}</p>
                  <p style={{ marginTop: "10px" }}>Possible solutions:</p>
                  <ul style={{ marginLeft: "20px", lineHeight: "1.5" }}>
                    <li><strong>Check backend deployment</strong> - Verify that your Lambda functions and DynamoDB tables are correctly deployed</li>
                    <li><strong>Verify API Gateway configuration</strong> - Ensure the API Gateway endpoint is configured correctly</li>
                    <li><strong>Check IAM permissions</strong> - Make sure the Lambda functions have permission to access DynamoDB tables</li>
                    <li><strong>Inspect DynamoDB tables</strong> - Verify that EvaluationSummariesTable and EvaluationResultsTable exist</li>
                    <li><strong>Check network connectivity</strong> - Ensure your frontend can reach the backend API</li>
                  </ul>
                </div>
              ) : (
                <>
                  <p>There are no LLM evaluations in the database yet. This is expected for new deployments. Follow these steps to get started:</p>
                  <ol style={{ marginLeft: "20px", lineHeight: "1.5" }}>
                    <li><strong>Ensure backend deployment</strong> - Make sure the backend API and Lambda functions are properly deployed</li>
                    <li><strong>Check CORS configuration</strong> - Ensure the API Gateway has CORS enabled with appropriate origins</li>
                    <li><strong>Upload test cases</strong> - Go to the "Add Test Cases" tab to upload JSON files containing test questions and expected answers</li>
                    <li><strong>Run an evaluation</strong> - Navigate to the "New Evaluation" tab to start a new evaluation run using your test cases</li>
                    <li><strong>View results</strong> - Once complete, return to this tab to view performance metrics and trends</li>
                  </ol>
                  <p style={{ marginTop: "10px" }}>If you're seeing a "Cross-Origin Request Blocked" message, you need to update the CORS configuration in your API Gateway. Add your frontend origin to the allowed origins list.</p>
                </>
              )}
            </Alert>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <button 
                onClick={props.addTestCasesHandler || props.tabChangeFunction} 
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#0972d3',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  boxShadow: '0 2px 5px rgba(0,0,0,0.1)'
                }}
              >
                Upload Test Cases
              </button>
              <button 
                onClick={props.newEvalHandler || props.tabChangeFunction} 
                style={{
                  padding: '10px 20px',
                  backgroundColor: '#0972d3',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  boxShadow: '0 2px 5px rgba(0,0,0,0.1)'
                }}
              >
                Start New Evaluation
              </button>
            </div>
          </SpaceBetween>
        </Container>
      );
    }
  
    // Sample scores
    const last_entry = items[0];
    const acc_score = last_entry['average_correctness'] * 100; // Score out of 100
    const rel_score = last_entry['average_relevance'] * 100; // Score out of 100
    const sim_score = last_entry['average_similarity'] * 100; // Score out of 100
  
    // Create arrays for accuracy, relevancy, and similarity data based on items
    const accuracyData = items.map((item, index) => ({
      x: new Date(item.Timestamp).getTime(),
      y: item['average_correctness'] * 100 // Score out of 100
    }));
  
    const relevancyData = items.map((item, index) => ({
      x: new Date(item.Timestamp).getTime(),
      y: item['average_relevance'] * 100
    }));
  
    const similarityData = items.map((item, index) => ({
      x: new Date(item.Timestamp).getTime(),
      y: item['average_similarity'] * 100
    }));
  
    return (    
            <SpaceBetween size="xxl" direction="vertical">
              <Grid
                gridDefinition={[
                  { colspan: { default: 12, xs: 4 } },
                  { colspan: { default: 12, xs: 4 } },
                  { colspan: { default: 12, xs: 4 } },
                ]}
              >
                <Container header={<Header variant="h3">Accuracy</Header>}>
                  <ProgressBar
                    value={acc_score}
                    description="Answer Correctness breaks down answers into different factual statements and looks at the overlap of statements in the expected answer given in a test case and the generated answer from the LLM"
                    resultText={`${acc_score}%`}
                  />
                </Container>
                <Container header={<Header variant="h3">Relevancy</Header>}>
                  <ProgressBar
                    value={rel_score}
                    description="Answer Relevancy looks at the generated answer and uses an LLM to guess what questions it may be answering. The better the LLM guesses the original question, the more relevant the generated answer is"
                    resultText={`${rel_score}%`}
                  />
                </Container>
                <Container header={<Header variant="h3">Similarity</Header>}>
                  <ProgressBar
                    value={sim_score}
                    description="Answer Similarity looks only at the semantic similarity of the expected answer and the LLM generated answer by finding the cosine similarity between the two answers and converting it into a score"
                    resultText={`${sim_score}%`}
                  />
                </Container>
              </Grid>
  
              {/* Combined Line Chart for All Metrics */}
              <Container header={<Header variant="h3">Performance Trends</Header>}>
                <LineChart
                  series={[
                    { title: "Accuracy", type: "line", data: accuracyData },
                    { title: "Relevancy", type: "line", data: relevancyData },
                    { title: "Similarity", type: "line", data: similarityData },
                  ]}
                  xDomain={[
                    Math.min(...items.map(i => new Date(i.Timestamp).getTime())), 
                    Math.max(...items.map(i => new Date(i.Timestamp).getTime()))
                  ]}
                  yDomain={[50, 100]}// Adjust based on the data range
                  //xTickValues={[1, 2, 3, 4, 5]}
                  i18nStrings={{
                    legendAriaLabel: "Legend",
                    chartAriaRoleDescription: "line chart",
                    xTickFormatter: value =>
                      new Date(value)
                        .toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "numeric",
                          hour12: false
                        })
                        .split(",")
                        .join("\n"),
                    yTickFormatter: value => `${value.toFixed(0)}%`,
                  }}
                  ariaLabel="Metrics over time"
                />
              </Container>
            </SpaceBetween>
    )
  }