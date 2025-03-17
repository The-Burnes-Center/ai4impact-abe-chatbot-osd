import React, { useContext, useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Box,
  SpaceBetween,
  Table,
  Pagination,
  Button,
  Header,
  StatusIndicator,
} from "@cloudscape-design/components";
import { Utils } from "../../common/utils";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { useNotifications } from "../../components/notif-manager";
import { getColumnDefinition } from "./columns";
import { useNavigate } from "react-router-dom";
import { AdminDataType } from "../../common/types";

const findFirstSortableColumn = (columns) => {
  return columns.find(col => col.sortingField && !col.disableSort) || columns[0];
};

export default function PastEvalsTab(props: PastEvalsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const [loading, setLoading] = useState(true);
  const [evaluations, setEvaluations] = useState([]);
  const { addNotification } = useNotifications();
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState([]);
  const needsRefresh = useRef(true); // Set default to true to ensure initial load
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Handle click on evaluation item
  const onProblemClick = useCallback((evaluationItem) => {
    // Make sure we have the correct property name (EvaluationId vs evaluationId)
    const evaluationId = evaluationItem.EvaluationId || evaluationItem.evaluationId;
    if (evaluationId) {
      navigate(`/admin/llm-evaluation/details/${evaluationId}`);
    }
  }, [navigate]);

  const columnDefinitions = getColumnDefinition(props.documentType, onProblemClick);
  const defaultSortingColumn = findFirstSortableColumn(columnDefinitions);
  const currentPageItems = pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Items || [];

  const { items, collectionProps, paginationProps } = useCollection(
    currentPageItems,
    {
      sorting: {
        defaultState: {
          sortingColumn: defaultSortingColumn,
          isDescending: false,
        },
      },
    }
  );

  // add text to refresh btn
  useEffect(() => {
    const divs = document.querySelectorAll('div.awsui_child_18582_1wlz1_145');
    let btn;
    for (const div of divs) {
      btn = div.querySelector('button.awsui_button_vjswe_1tt9v_153');
      if (btn) {
        const hiddenSpan = document.createElement('span');
        hiddenSpan.innerText = 'Refresh past evaluations';
    
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
        break;
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

  // Load evaluation data
  const getEvaluations = useCallback(
    async (params : { pageIndex?: number, nextPageToken? }) => {
      setLoading(true);
      try {
        const result = await apiClient.evaluations.getEvaluationSummaries(params.nextPageToken);
        
        // Check if there's an error in the result
        if (result.error) {
          setError(result.error);
          setPages([]);
          setLoading(false);
          return;
        }
        
        // Check if result exists and has Items property
        if (!result || !result.Items) {
          setError("No evaluation data available. This could be due to an empty database or a configuration issue.");
          setPages([]);
          setLoading(false);
          return;
        }
        
        // Map the evaluations to the expected format
        const processedResult = {
          ...result,
          Items: result.Items.map(evaluation => ({
            ...evaluation,
            // Ensure we have the required fields with correct casing for the UI
            EvaluationId: evaluation.EvaluationId,
            evaluationId: evaluation.EvaluationId, // Add both versions for safety
            evaluation_name: evaluation.evaluation_name || "Unnamed Evaluation",
            Timestamp: evaluation.Timestamp,
            average_similarity: typeof evaluation.average_similarity === 'number' ? evaluation.average_similarity : 0,
            average_relevance: typeof evaluation.average_relevance === 'number' ? evaluation.average_relevance : 0,
            average_correctness: typeof evaluation.average_correctness === 'number' ? evaluation.average_correctness : 0,
            // Add new retrieval metrics
            average_context_precision: typeof evaluation.average_context_precision === 'number' ? evaluation.average_context_precision : 0,
            average_context_recall: typeof evaluation.average_context_recall === 'number' ? evaluation.average_context_recall : 0,
            average_response_relevancy: typeof evaluation.average_response_relevancy === 'number' ? evaluation.average_response_relevancy : 0,
            average_faithfulness: typeof evaluation.average_faithfulness === 'number' ? evaluation.average_faithfulness : 0,
            total_questions: evaluation.total_questions || 0
          }))
        };
        
        // Clear any previous errors
        setError(null);
        
        // Update pages state
        setPages((current) => {
          if (needsRefresh.current) {
            needsRefresh.current = false;
            return [processedResult];
          }
          if (typeof params.pageIndex !== "undefined") {
            // Create a new array with the updated page
            const newPages = [...current];
            newPages[params.pageIndex - 1] = processedResult;
            return newPages;
          } else {
            return [...current, processedResult];
          }
        });
      } catch (error) {
        const errorMessage = Utils.getErrorMessage(error);
        setError(`Failed to load evaluations: ${errorMessage}`);
        setPages([]);
      } finally {
        setLoading(false);
      }
    },
    [apiClient]
  );

  // Initial data fetch
  useEffect(() => {
    needsRefresh.current = true;
    setCurrentPageIndex(1);
    getEvaluations({ pageIndex: 1 });
  }, [getEvaluations]);

  const onNextPageClick = async () => {
    const continuationToken = pages[currentPageIndex - 1]?.NextPageToken;
    if (continuationToken) {
      if (pages.length <= currentPageIndex || needsRefresh.current) {
        await getEvaluations({ nextPageToken: continuationToken });
      }
      setCurrentPageIndex((current) => Math.min(pages.length + 1, current + 1));
    }
  };


  const onPreviousPageClick = () => {
    setCurrentPageIndex((current) => Math.max(1, current - 1));
  };


  return (
    <Table
      {...collectionProps}
      loading={loading}
      loadingText={"Loading evaluations"}
      columnDefinitions={columnDefinitions}
      items={items}
      trackBy="evaluation_id"
      sortingColumn={collectionProps.sortingColumn || defaultSortingColumn}
      sortingDescending={collectionProps.sortingDescending}
      onSortingChange={(event) => {
      collectionProps.onSortingChange(event);
      }}
      header={
        <Header
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button iconName="refresh" onClick={() => getEvaluations({ pageIndex: currentPageIndex })} />
            </SpaceBetween>
          }
        >
          {"Past Evaluations"}
        </Header>
      }
      empty={
        <Box textAlign="center">
          {error ? (
            <StatusIndicator type="error">{error}</StatusIndicator>
          ) : (
            <StatusIndicator type="warning">No evaluations found</StatusIndicator>
          )}
        </Box>
      }
      pagination={
        pages.length === 0 ? null : (
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
  );
}

export interface PastEvalsTabProps {
  tabChangeFunction: () => void;
  documentType: AdminDataType;
}