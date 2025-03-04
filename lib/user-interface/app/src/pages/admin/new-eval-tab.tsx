import {
    Box,
    Button,
    Container,
    Form,
    Header,
    Input,
    Pagination,
    SpaceBetween,
    Table,
  } from "@cloudscape-design/components";
  import { useCallback, useContext, useEffect, useState } from "react";
  import { AppContext } from "../../common/app-context";
  import { ApiClient } from "../../common/api-client/api-client";
  import { Utils } from "../../common/utils";
  import { useNotifications } from "../../components/notif-manager";
  import { useCollection } from "@cloudscape-design/collection-hooks";
  import { getColumnDefinition } from "./columns";
  import { AdminDataType } from "../../common/types";
  import { useNavigate } from "react-router-dom";

  export interface FileUploadTabProps {
    tabChangeFunction: () => void;
    documentType: AdminDataType;
  }

  const onProblemClick = (NewEvaluationItem): void => {
    console.log("New Evaluation item: ", NewEvaluationItem);
    const navigate = useNavigate();
    navigate(`/admin/llm-evaluation/${NewEvaluationItem.evaluationId}`);
  }

  export default function NewEvalTab(props: FileUploadTabProps) {
    const appContext = useContext(AppContext);
    const apiClient = new ApiClient(appContext);
    const { addNotification } = useNotifications();

    const [evalName, setEvalName] = useState<string>("SampleEvalName");
    const [globalError, setGlobalError] = useState<string | undefined>(undefined);

    const [loading, setLoading] = useState(true);
    const [currentPageIndex, setCurrentPageIndex] = useState(1);
    const [pages, setPages] = useState<any[]>([]);
    const [selectedFile, setSelectedFile] = useState<any | null>(null);

    const { items, collectionProps, paginationProps } = useCollection(pages, {
      filtering: {
        empty: (
          <Box margin={{ vertical: "xs" }} textAlign="center" color="inherit">
            <SpaceBetween size="m">
              <b>No files</b>
            </SpaceBetween>
          </Box>
        ),
      },
      pagination: { pageSize: 5 },
      sorting: {
        defaultState: {
          sortingColumn: {
            sortingField: "Key",
          },
          isDescending: true,
        },
      },
      selection: {},
    });

  // add text to header column for radio inputs
  useEffect(() => {
    const divs = document.querySelectorAll('div.awsui_child_18582_1wlz1_145');
    let div2;
    let input;
    for (const div of divs) {
      div2 = div.querySelector('div.awsui_root_2rhyz_137vc_141');
      input = div2?.querySelector('input');
      if (input) {
        input.setAttribute('title', 'Evaluation Name');
        break;
      }
    }
  }, []);

  // add text to refresh btn
  useEffect(() => {
    const divs = document.querySelectorAll('div.awsui_child_18582_1wlz1_145');
    let btn;
    for (const div of divs) {
      btn = div.querySelector('button.awsui_button_vjswe_1tt9v_153');
      if (btn) {
        btn.setAttribute('aria-label', 'Refresh test case documents');
      }
    }
  }, []);  
  
  // add text to arrow buttons that navigate through the pages
  useEffect(() => {
    const addPaginationLabels = () => {
      const ls = document.querySelector('ul.awsui_root_fvjdu_chz9p_141');
      if (ls) {
        const listItems = ls.querySelectorAll('li');
        
        // all the buttons in between are the page numbers and already have text
        if (listItems.length !== 0) {
          const leftArrow = listItems[0].querySelector('button');
          const rightArrow = listItems[listItems.length - 1].querySelector('button');
          rightArrow.setAttribute('aria-label', 'Go to next page');
          leftArrow.setAttribute('aria-label', 'Go to previous page');
        }
      }
    };
  
    // iniital run
    addPaginationLabels();
  
    const observer = new MutationObserver(() => {
      addPaginationLabels();
    });
  
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  
    return () => observer.disconnect();
  }, []);

  // make table accessible by adding text to checkbox column
  useEffect(() => {
    const updateLabels = () => {
      // select all labels of checkbox inputs
      const labels = document.querySelectorAll('label.awsui_label_1s55x_1iop1_145');
  
      labels.forEach((label, index) => {
        const labelElement = label as HTMLLabelElement;
        const checkbox = label.querySelector('input[type="radio"]'); // finds radio input under label tag
    
        if (checkbox instanceof HTMLInputElement) {
          // add a span of hidden text
          let hiddenSpan = label.querySelector('.hidden-span') as HTMLSpanElement;
          if (!hiddenSpan) {
            hiddenSpan = document.createElement('span');
            hiddenSpan.className = 'hidden-span';
            hiddenSpan.innerText = checkbox.checked
              ? `Unselect row ${index + 1}`
              : `Select row ${index + 1}`;
  
            hiddenSpan.style.position = 'absolute';
            hiddenSpan.style.width = '1px';
            hiddenSpan.style.height = '1px';
            hiddenSpan.style.padding = '0';
            hiddenSpan.style.margin = '-1px';
            hiddenSpan.style.overflow = 'hidden';
            hiddenSpan.style.whiteSpace = 'nowrap';
            hiddenSpan.style.border = '0';
  
            labelElement.appendChild(hiddenSpan);
          }
  
          // handles checkbox status changes
          const onChangeHandler = () => {
            if (index === 0) {
              hiddenSpan.innerText = checkbox.checked
                ? `Unselect all rows`
                : `Select all rows`;
            } else {
              hiddenSpan.innerText = checkbox.checked
                ? `Unselect row ${index + 1}`
                : `Select row ${index + 1}`;
            }
          };
  
          if (!checkbox.dataset.listenerAdded) {
            checkbox.addEventListener('change', onChangeHandler);
            checkbox.dataset.listenerAdded = 'true';
          }
        }
      });
    };
  
    // first call
    updateLabels();
  
    // monitor changes to table (table items render after the header does)
    const table = document.querySelector('table');
    if (table) {
      const observer = new MutationObserver(() => {
        updateLabels();
      });
  
      observer.observe(table, {
        childList: true,
        subtree: true,
      });
  
      return () => observer.disconnect();
    }
  }, []);

  // add text to header column for radio inputs
  useEffect(() => {
    const btn = document.querySelector('th.awsui_header-cell_1spae_r2f6t_145');
    
    if (btn) {
      const hiddenSpan = document.createElement('span');
      hiddenSpan.innerText = 'Selection';
  
      // makes text invisible
      hiddenSpan.style.position = 'absolute';
      hiddenSpan.style.width = '1px';
      hiddenSpan.style.height = '1px';
      hiddenSpan.style.padding = '0';
      hiddenSpan.style.margin = '-1px';
      hiddenSpan.style.overflow = 'hidden';
      hiddenSpan.style.whiteSpace = 'nowrap';
      hiddenSpan.style.border = '0';
  
      btn.appendChild(hiddenSpan);
    }
  
  }, []);

    const onNewEvaluation = async () => {
      // Clear any previous error
      setGlobalError(undefined);
      
      // Validate evaluation name
      if (evalName === "SampleEvalName" || evalName.trim() === "") {
        setGlobalError("Please enter a name for the evaluation");
        return;
      }
      
      // Validate file selection
      if (!selectedFile) {
        setGlobalError("Please select a file for evaluation");
        return;
      }
      
      // Validate file extension (should be .json)
      if (!selectedFile.Key.toLowerCase().endsWith('.json')) {
        setGlobalError("Please select a valid JSON test case file");
        return;
      }
      
      try {
        // Show loading state
        setLoading(true);
        
        // Start the evaluation
        const result = await apiClient.evaluations.startNewEvaluation(evalName, selectedFile.Key);
        
        // Show success notification
        addNotification("success", "Evaluation started successfully. It may take a few minutes to complete.");
        
        // Optionally navigate to the current evaluations tab
        props.tabChangeFunction();
      } catch (error) {
        console.error("Error starting evaluation:", error);
        const errorMessage = Utils.getErrorMessage(error);
        
        // Show a more specific error message
        if (errorMessage.includes("NetworkError") || errorMessage.includes("Failed to fetch")) {
          setGlobalError("Network error: Unable to connect to the evaluation service");
          addNotification("error", "Network error: Unable to connect to the evaluation service");
        } else if (errorMessage.includes("Unauthorized") || errorMessage.includes("403")) {
          setGlobalError("Authorization error: You don't have permission to start evaluations");
          addNotification("error", "Authorization error: You don't have permission to start evaluations");
        } else {
          setGlobalError(`Error starting evaluation: ${errorMessage}`);
          addNotification("error", `Error starting evaluation: ${errorMessage}`);
        }
      } finally {
        setLoading(false);
      }
    };

    /** Function to get documents */
    const getDocuments = useCallback(
        async (params: { continuationToken?: string; pageIndex?: number }) => {
        setLoading(true);
        try {
            const result = await apiClient.evaluations.getDocuments(params?.continuationToken, params?.pageIndex)
            // await props.statusRefreshFunction();
            setPages((current) => {
            if (typeof params.pageIndex !== "undefined") {
                current[params.pageIndex - 1] = result;
                return [...current];
            } else {
                return [...current, result];
            }
            });
        } catch (error) {
            console.error(Utils.getErrorMessage(error));
        }

        console.log(pages);
        setLoading(false);
        },
        [appContext, props.documentType]
    );

    /** Whenever the memoized function changes, call it again */
    useEffect(() => {
        getDocuments({});
    }, [getDocuments]);

    /** Handle clicks on the next page button, as well as retrievals of new pages if needed*/
    const onNextPageClick = async () => {
        const continuationToken = pages[currentPageIndex - 1]?.NextContinuationToken;

        if (continuationToken) {
        if (pages.length <= currentPageIndex) {
            await getDocuments({ continuationToken });
        }
        setCurrentPageIndex((current) => Math.min(pages.length + 1, current + 1));
        }
    };

    /** Handle clicks on the previous page button */
    const onPreviousPageClick = async () => {
        setCurrentPageIndex((current) =>
        Math.max(1, Math.min(pages.length - 1, current - 1))
        );
    };

    /** Handle refreshes */
    const refreshPage = async () => {
        // console.log(pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Contents!)
        if (currentPageIndex <= 1) {
        await getDocuments({ pageIndex: currentPageIndex });
        } else {
        const continuationToken = pages[currentPageIndex - 2]?.NextContinuationToken!;
        await getDocuments({ continuationToken });
        }
    };

    const columnDefinitions = getColumnDefinition(props.documentType, onProblemClick);

    return (
      <>
        <Form errorText={globalError}>
          <SpaceBetween size="l">
            <Container>
              <SpaceBetween direction="horizontal" size="s">
                <label style={{ alignSelf: 'center' }}>Evaluation Name:</label>
                <Input
                  value={evalName}
                  placeholder="SampleEvalName"
                  onChange={(event) => setEvalName(event.detail.value)}
                />
                <Button
                  data-testid="new-evaluation"
                  variant="primary"
                  onClick={onNewEvaluation}
                  disabled={!selectedFile}
                >
                  Create New Evaluation
                </Button>
              </SpaceBetween>
            </Container>

            {/* Adding space between the container and table */}
            <Box padding={{ top: "xxs" }} />

            {/* Table Section */}
            <Table
              {...collectionProps}
              loading={loading}
              loadingText={`Loading files`}
              columnDefinitions={columnDefinitions}
              selectionType="single"
              onSelectionChange={({ detail }) => {
                const clickedFile = detail.selectedItems[0];
                setSelectedFile((prev) => (clickedFile && prev && clickedFile.Key === prev.Key ? null : clickedFile));
              }}
              selectedItems={selectedFile ? [selectedFile] : []}
              items={pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Contents!}
              trackBy="Key"
              header={
                <Header
                  actions={
                    <Button iconName="refresh" onClick={refreshPage} />
                  }
                  description="Please select a test case file for your next evaluation. Press the refresh button to see the latest test case files."
                >
                  {"Files"}
                </Header>
              }
              empty={<Box textAlign="center">No test case files uploaded. Please upload a test case file before running an evaluation.</Box>}
              pagination={
                pages.length > 0 && (
                  <Pagination
                    openEnd={true}
                    pagesCount={pages.length}
                    currentPageIndex={currentPageIndex}
                    onNextPageClick={onNextPageClick}
                    onPreviousPageClick={onPreviousPageClick}
                  />
                )
              }
            />
          </SpaceBetween>
        </Form>
      </>
    );
  }
