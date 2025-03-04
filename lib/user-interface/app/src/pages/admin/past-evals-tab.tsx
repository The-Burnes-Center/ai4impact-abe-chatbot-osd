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

const onProblemClick = (EvaluationItem): void => {
  console.log(" evaluation item: ", EvaluationItem);
  const navigate = useNavigate();
  navigate(`/admin/llm-evaluation/${EvaluationItem.evaluationId}`);
};


export interface PastEvalsTabProps {
  tabChangeFunction: () => void;
  documentType: AdminDataType;
}

export default function PastEvalsTab(props: PastEvalsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const [loading, setLoading] = useState(true);
  const [evaluations, setEvaluations] = useState([]);
  const { addNotification } = useNotifications();
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState([]);
  const needsRefresh = useRef(false);
  const [error, setError] = useState<string | null>(null);

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

  /** Function to get evaluations from api*/
  const getEvaluations = useCallback(
    async (params : { pageIndex?: number, nextPageToken? }) => {
      setLoading(true);
      try {
        const result = await apiClient.evaluations.getEvaluationSummaries(params.nextPageToken);
        
        // Check if there's an error in the result
        if (result.error) {
          console.error("Error from API:", result.error);
          setError(result.error);
          setPages([]);
          setLoading(false);
          return;
        }
        
        // Check if result exists and has Items property
        if (!result || !result.Items) {
          console.log("No evaluations found or unexpected response structure");
          setError("No evaluation data available. This could be due to an empty database or a configuration issue.");
          setPages([]);
          setLoading(false);
          return;
        }
        
        // Clear any previous errors
        setError(null);
        
        setPages((current) => {
          if (needsRefresh.current) {
            needsRefresh.current = false;
            return [result];
          }
          if (typeof params.pageIndex !== "undefined") {
            current[params.pageIndex - 1] = result;
            return [...current];
          } else {
            return [...current, result];
          }
        });
      } catch (error) {
        console.error("Error fetching evaluations:", error);
        const errorMessage = Utils.getErrorMessage(error);
        console.error("Error details:", errorMessage);
        setError(`Failed to load evaluations: ${errorMessage}`);
        setPages([]);
      } finally {
        setLoading(false);
      }
    },
    [apiClient]
  );

  useEffect(() => {
    setCurrentPageIndex(1);
    if (needsRefresh.current) {
      getEvaluations({ pageIndex: 1 });
    } else {
      getEvaluations({ pageIndex: currentPageIndex });
    }
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