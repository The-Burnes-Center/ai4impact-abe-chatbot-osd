import {
  Box,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  IconButton,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { getColumnDefinition } from "./columns";
import { Utils } from "../../common/utils";
import React from "react";
import { useNotifications } from "../../components/notif-manager";
import { feedbackCategories } from "../../common/constants";
import { useNavigate } from "react-router-dom";
import CircularProgress from "@mui/material/CircularProgress";

export interface FeedbackTabProps {
  updateSelectedFeedback: React.Dispatch<any>;
  selectedFeedback: React.Dispatch<any>;
}

export default function FeedbackTab(props: FeedbackTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [loading, setLoading] = useState(true);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState<any[]>([]);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [showModalDelete, setShowModalDelete] = useState(false);
  const needsRefresh = useRef<boolean>(false);
  const navigate = useNavigate();

  const onProblemClick = (feedbackItem) => {
    console.log(feedbackItem);
    navigate(`/admin/user-feedback/${feedbackItem.FeedbackID}`, {
      state: { feedback: feedbackItem },
    });
  };

  const [selectedOption, setSelectedOption] = React.useState({
    label: "Any",
    value: "any",
  });
  const [startDate, setStartDate] = React.useState(
    new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate() - 1
    )
      .toISOString()
      .split("T")[0]
  );
  const [endDate, setEndDate] = React.useState(
    new Date().toISOString().split("T")[0]
  );

  const { addNotification, removeNotification } = useNotifications();

  const getFeedback = useCallback(
    async (params: { pageIndex?; nextPageToken? }) => {
      setLoading(true);
      try {
        const result = await apiClient.userFeedback.getUserFeedback(
          selectedOption.value,
          startDate + "T00:00:00",
          endDate + "T23:59:59",
          params.nextPageToken
        );

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
        console.error(Utils.getErrorMessage(error));
      }
      setLoading(false);
    },
    [appContext, selectedOption, startDate, endDate, needsRefresh]
  );

  useEffect(() => {
    setCurrentPageIndex(1);
    setSelectedItems([]);
    if (needsRefresh.current) {
      getFeedback({ pageIndex: 1 });
    } else {
      getFeedback({ pageIndex: currentPageIndex });
    }
  }, [getFeedback]);

  const onNextPageClick = async () => {
    const continuationToken = pages[currentPageIndex - 1]?.NextPageToken;
    if (continuationToken) {
      if (pages.length <= currentPageIndex || needsRefresh.current) {
        await getFeedback({ nextPageToken: continuationToken });
      }
      setCurrentPageIndex((current) =>
        Math.min(pages.length + 1, current + 1)
      );
    }
  };

  const onPreviousPageClick = async () => {
    setCurrentPageIndex((current) =>
      Math.max(1, Math.min(pages.length - 1, current - 1))
    );
  };

  const refreshPage = async () => {
    if (currentPageIndex <= 1) {
      await getFeedback({ pageIndex: currentPageIndex });
    } else {
      const continuationToken = pages[currentPageIndex - 2]?.NextPageToken!;
      await getFeedback({
        pageIndex: currentPageIndex,
        nextPageToken: continuationToken,
      });
    }
  };

  const columnDefinitions = getColumnDefinition("feedback", onProblemClick);

  const deleteSelectedFeedback = async () => {
    if (!appContext) return;
    setLoading(true);
    setShowModalDelete(false);
    const apiClient = new ApiClient(appContext);
    await Promise.all(
      selectedItems.map((s) =>
        apiClient.userFeedback.deleteFeedback(s.Topic, s.CreatedAt)
      )
    );
    await getFeedback({ pageIndex: currentPageIndex });
    setSelectedItems([]);
    setLoading(false);
  };

  const currentItems =
    pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Items || [];

  const handleRowClick = (item) => {
    props.updateSelectedFeedback(item);
    setSelectedItems([item]);
  };

  return (
    <>
      <Dialog
        open={showModalDelete}
        onClose={() => setShowModalDelete(false)}
      >
        <DialogTitle>
          {"Delete feedback" + (selectedItems.length > 1 ? "s" : "")}
        </DialogTitle>
        <DialogContent>
          <Typography>
            Do you want to delete{" "}
            {selectedItems.length == 1
              ? `Feedback ${selectedItems[0]?.FeedbackID}?`
              : `${selectedItems.length} Feedback?`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModalDelete(false)}>Cancel</Button>
          <Button onClick={deleteSelectedFeedback} variant="contained">
            Ok
          </Button>
        </DialogActions>
      </Dialog>

      <Stack spacing={2}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap={1}
        >
          <Box>
            <Typography variant="h6">Feedback</Typography>
            <Typography variant="body2" color="text.secondary">
              Please expect a delay for your changes to be reflected. Press the
              refresh button to see the latest changes.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <TextField
              type="date"
              label="Start Date"
              value={startDate}
              onChange={(e) => {
                needsRefresh.current = true;
                setStartDate(e.target.value);
              }}
              size="small"
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              type="date"
              label="End Date"
              value={endDate}
              onChange={(e) => {
                needsRefresh.current = true;
                setEndDate(e.target.value);
              }}
              size="small"
              InputLabelProps={{ shrink: true }}
            />
            <FormControl size="small" sx={{ minWidth: 120 }}>
              <InputLabel>Category</InputLabel>
              <Select
                value={selectedOption.value}
                label="Category"
                onChange={(e) => {
                  needsRefresh.current = true;
                  const opt = [
                    ...feedbackCategories,
                    { label: "Any", value: "any", disabled: false },
                  ].find((o) => o.value === e.target.value);
                  setSelectedOption({
                    label: opt?.label || "Any",
                    value: e.target.value,
                  });
                }}
              >
                {[
                  ...feedbackCategories,
                  { label: "Any", value: "any", disabled: false },
                ].map((opt) => (
                  <MenuItem
                    key={opt.value}
                    value={opt.value}
                    disabled={opt.disabled}
                  >
                    {opt.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <IconButton onClick={refreshPage} aria-label="Refresh">
              <RefreshIcon />
            </IconButton>
            <Button
              variant="contained"
              size="small"
              onClick={() => {
                apiClient.userFeedback.downloadFeedback(
                  selectedOption.value,
                  startDate,
                  endDate
                );
                const id = addNotification(
                  "success",
                  "Your files have been downloaded."
                );
                Utils.delay(3000).then(() => removeNotification(id));
              }}
            >
              Download
            </Button>
            <Button
              variant="contained"
              color="error"
              size="small"
              disabled={selectedItems.length === 0}
              onClick={() => {
                if (selectedItems.length > 0) setShowModalDelete(true);
              }}
            >
              Delete
            </Button>
          </Stack>
        </Stack>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress />
          </Box>
        ) : currentItems.length === 0 ? (
          <Box sx={{ textAlign: "center", p: 4 }}>
            <Typography color="text.secondary">
              No feedback available
            </Typography>
          </Box>
        ) : (
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {columnDefinitions.map((col) => (
                    <TableCell key={col.id} sx={{ fontWeight: "bold" }}>
                      {col.header}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {currentItems.map((item, index) => (
                  <TableRow
                    key={item.FeedbackID || index}
                    hover
                    selected={selectedItems.some(
                      (s) => s.FeedbackID === item.FeedbackID
                    )}
                    onClick={() => handleRowClick(item)}
                    sx={{ cursor: "pointer" }}
                  >
                    {columnDefinitions.map((col) => (
                      <TableCell key={col.id}>{col.cell(item)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {pages.length > 0 && (
          <Stack
            direction="row"
            justifyContent="center"
            spacing={2}
            sx={{ py: 1 }}
          >
            <Button
              size="small"
              disabled={currentPageIndex <= 1}
              onClick={onPreviousPageClick}
            >
              Previous
            </Button>
            <Typography variant="body2" sx={{ alignSelf: "center" }}>
              Page {currentPageIndex}
            </Typography>
            <Button
              size="small"
              disabled={!pages[currentPageIndex - 1]?.NextPageToken}
              onClick={onNextPageClick}
            >
              Next
            </Button>
          </Stack>
        )}
      </Stack>
    </>
  );
}
