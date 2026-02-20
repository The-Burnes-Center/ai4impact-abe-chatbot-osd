import {
  Box,
  SpaceBetween,
  Table,
  Pagination,
  Button,
  Header,
  Modal,
  Spinner,
} from "@cloudscape-design/components";
import { useCallback, useContext, useEffect, useState, useRef } from "react";
import { AdminDataType } from "../../common/types";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { getColumnDefinition } from "./columns";
import { Utils } from "../../common/utils";
import { useCollection } from "@cloudscape-design/collection-hooks";
import { useNotifications } from "../../components/notif-manager";

export interface DocumentsTabProps {
  tabChangeFunction: () => void;
  documentType: AdminDataType;
  statusRefreshFunction: () => void;
  lastSyncTime: string | null;
  setShowUnsyncedAlert: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function DocumentsTab(props: DocumentsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState<any[]>([]);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [showModalDelete, setShowModalDelete] = useState(false);
  const { addNotification, removeNotification } = useNotifications();
  const previousSyncStatusRef = useRef<boolean>(false);

  /** Pagination, but this is currently not working.
   * You will likely need to take the items object from useCollection in the
   * Cloudscape component, but it currently just takes in pages directly.
   */
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

  useEffect(() => {
    // If no sync time available, don't show unsynced alert
    if (!props.lastSyncTime) {
      props.setShowUnsyncedAlert(false);
      return;
    }

    try {
      // Parse ISO 8601 UTC timestamp (e.g., "2026-02-20T14:17:00Z")
      const lastSyncDate = new Date(props.lastSyncTime);
      
      if (isNaN(lastSyncDate.getTime())) {
        console.error('Invalid lastSyncTime format:', props.lastSyncTime);
        props.setShowUnsyncedAlert(false);
        return;
      }

      // Check if any files have a LastModified date newer than the lastSyncTime
      const hasUnsyncedFiles = pages.some((page) =>
        page.Contents?.some((file) => {
          const fileDate = new Date(file.LastModified);
          return fileDate > lastSyncDate;
        })
      );

      props.setShowUnsyncedAlert(hasUnsyncedFiles);
    } catch (error) {
      console.error('Error comparing sync time:', error);
      props.setShowUnsyncedAlert(false);
    }
  }, [pages, props.lastSyncTime, props.setShowUnsyncedAlert]);

  /** Function to get documents */
  const getDocuments = useCallback(
    async (params: { continuationToken?: string; pageIndex?: number }) => {
      setLoading(true);
      try {
        const result = await apiClient.knowledgeManagement.getDocuments(params?.continuationToken, params?.pageIndex)
        await props.statusRefreshFunction();
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

  const columnDefinitions = getColumnDefinition(props.documentType, () => {});

  /** Deletes selected files */
  const deleteSelectedFiles = async () => {
    if (!appContext) return;
    setLoading(true);
    setShowModalDelete(false);

    const apiClient = new ApiClient(appContext);
    try {
      await Promise.all(
        selectedItems.map((s) => apiClient.knowledgeManagement.deleteFile(s.Key!))
      );
    } catch (e) {
      addNotification("error", "Error deleting files")
      console.error(e);
    }
    // refresh the documents after deletion
    await getDocuments({ pageIndex: currentPageIndex });

    setSelectedItems([])
    setLoading(false);
  };

  /** Start a polling interval to check sync status and disable the button if 
   * syncing is not completed. Also refreshes the last sync time when sync completes.
   * Uses a dynamic interval that polls more frequently (5s) when syncing is active.
   */
  useEffect(() => {
    if (!appContext) return;
    const apiClient = new ApiClient(appContext);
    let intervalId: NodeJS.Timeout | null = null;

    const getStatus = async () => {
      try {
        const result = await apiClient.knowledgeManagement.kendraIsSyncing();
        console.log("Sync status check:", result);
        const isCurrentlySyncing = result != "DONE SYNCING";
        const wasSyncing = previousSyncStatusRef.current;
        
        console.log(`Sync status: wasSyncing=${wasSyncing}, isCurrentlySyncing=${isCurrentlySyncing}`);
        
        /** Always update the syncing state based on current status */
        setSyncing(isCurrentlySyncing);
        
        /** If sync just completed (transitioned from syncing to done), refresh the last sync time */
        if (wasSyncing && !isCurrentlySyncing) {
          console.log("✅ Sync completed! Transition detected: wasSyncing=true -> isCurrentlySyncing=false");
          console.log("Calling statusRefreshFunction() to update last sync time...");
          try {
            // Add a small delay to ensure backend has updated the sync job status
            await new Promise(resolve => setTimeout(resolve, 1000));
            await props.statusRefreshFunction();
            console.log("✅ statusRefreshFunction() completed");
          } catch (error) {
            console.error("❌ Error calling statusRefreshFunction():", error);
          }
        } else if (wasSyncing && isCurrentlySyncing) {
          console.log("⏳ Still syncing...");
        } else if (!wasSyncing && !isCurrentlySyncing) {
          console.log("✅ No sync in progress");
        }
        
        // Update the ref AFTER checking for transition
        previousSyncStatusRef.current = isCurrentlySyncing;
        
        // Adjust polling frequency based on sync status
        if (intervalId) {
          clearInterval(intervalId);
        }
        // Poll every 5 seconds when syncing, 10 seconds when idle
        const pollInterval = isCurrentlySyncing ? 5000 : 10000;
        console.log(`Setting poll interval to ${pollInterval}ms (syncing: ${isCurrentlySyncing})`);
        intervalId = setInterval(getStatus, pollInterval);
      } catch (error) {
        addNotification("error", "Error checking sync status, please try again later.")
        console.error("Error checking sync status:", error);
        // On error, keep current polling interval
      }
    };

    // Initial check - set the ref based on current status
    getStatus().then(() => {
      // After first check, the ref will be set correctly
    });

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [appContext, props]);

  /** Function to run a sync */
  const syncKendra = async () => {
    if (syncing) {
      // setSyncing(false)
      return;
    }
    console.log("Starting sync...");
    setSyncing(true);
    previousSyncStatusRef.current = true; // Track that sync has started
    console.log("Set previousSyncStatusRef.current to true");
    try {
      const state = await apiClient.knowledgeManagement.syncKendra();
      console.log("Sync started, response:", state);
      if (state != "STARTED SYNCING") {
        addNotification("error", "Error running sync, please try again later.")
        setSyncing(false)
        previousSyncStatusRef.current = false;
        return;
      }
      // Sync started successfully - polling will detect when it completes
      // Force an immediate status check after a short delay to catch quick syncs
      setTimeout(async () => {
        try {
          const result = await apiClient.knowledgeManagement.kendraIsSyncing();
          const isCurrentlySyncing = result != "DONE SYNCING";
          console.log("Immediate status check (2s after start):", result, "isSyncing:", isCurrentlySyncing);
          setSyncing(isCurrentlySyncing);
          previousSyncStatusRef.current = isCurrentlySyncing;
          if (!isCurrentlySyncing) {
            console.log("Sync completed quickly, refreshing last sync time");
            await props.statusRefreshFunction();
          }
        } catch (error) {
          console.error("Error in immediate status check:", error);
        }
      }, 2000); // Check after 2 seconds
    } catch (error) {
      console.log(error);
      addNotification("error", "Error running sync, please try again later.")
      setSyncing(false)
      previousSyncStatusRef.current = false;
    }
  }

  return (
    <><Modal
      onDismiss={() => setShowModalDelete(false)}
      visible={showModalDelete}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            {" "}
            <Button variant="link" onClick={() => setShowModalDelete(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={deleteSelectedFiles}>
              Ok
            </Button>
          </SpaceBetween>{" "}
        </Box>
      }
      header={"Delete file" + (selectedItems.length > 1 ? "s" : "")}
    >
      Do you want to delete{" "}
      {selectedItems.length == 1
        ? `file ${selectedItems[0].Key!}?`
        : `${selectedItems.length} files?`}
    </Modal>
      <Table
        {...collectionProps}
        loading={loading}
        loadingText={`Loading files`}
        columnDefinitions={columnDefinitions}
        selectionType="multi"
        onSelectionChange={({ detail }) => {
          console.log(detail);
          setSelectedItems(detail.selectedItems);
        }}
        selectedItems={selectedItems}
        items={pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Contents!}
        trackBy="Key"
        header={
          <Header
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button iconName="refresh" onClick={refreshPage} />
                <Button
                  onClick={props.tabChangeFunction}
                >
                  {'Add Files'}
                </Button>
                <Button
                  variant="primary"
                  disabled={selectedItems.length == 0}
                  onClick={() => {
                    if (selectedItems.length > 0) setShowModalDelete(true);
                  }}
                  data-testid="submit">
                  Delete
                </Button>
                <Button
                  variant="primary"
                  disabled={syncing}
                  onClick={() => {
                    syncKendra();
                  }}
                // data-testid="submit"
                >
                  {syncing ? (
                    <>
                      Syncing data...&nbsp;&nbsp;
                      <Spinner />
                    </>
                  ) : (
                    "Sync data now"
                  )}
                </Button>
              </SpaceBetween>
            }
            description="Please expect a delay for your changes to be reflected. Press the refresh button to see the latest changes."
          >
            {"Files"}
          </Header>
        }
        empty={
          <Box textAlign="center">No files available</Box>
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
    </>
  );
}
