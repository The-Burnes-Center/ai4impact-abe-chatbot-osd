import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TablePagination from "@mui/material/TablePagination";
import TableSortLabel from "@mui/material/TableSortLabel";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import CircularProgress from "@mui/material/CircularProgress";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import DeleteIcon from "@mui/icons-material/Delete";
import { useState, useEffect, useContext, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { Auth } from 'aws-amplify';
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import RouterButton from "../wrappers/router-button";
import { DateTime } from "luxon";

export interface SessionsProps {
  readonly toolsOpen: boolean;
}

type Order = "asc" | "desc";

export default function Sessions(props: SessionsProps) {
  const appContext = useContext(AppContext);
  const [sessions, setSessions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [showModalDelete, setShowModalDelete] = useState(false);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(20);
  const [order, setOrder] = useState<Order>("desc");
  const [orderBy, setOrderBy] = useState("time_stamp");

  const getSessions = useCallback(async () => {
    if (!appContext) return;
    let username;
    const apiClient = new ApiClient(appContext);
    try {
      await Auth.currentAuthenticatedUser().then((value) => username = value.username);
      if (username) {
        const result = await apiClient.sessions.getSessions(username,true);
        setSessions(result);
      }
    } catch (e) {
      console.log(e);
      setSessions([]);
    }
  }, [appContext]);

  useEffect(() => {
    if (!appContext) return;

    (async () => {
      setIsLoading(true);
      await getSessions();
      setIsLoading(false);
    })();
  }, [appContext, getSessions, props.toolsOpen]);

  const deleteSelectedSessions = async () => {
    if (!appContext) return;
    let username;
    await Auth.currentAuthenticatedUser().then((value) => username = value.username);
    setIsLoading(true);
    const apiClient = new ApiClient(appContext);
    const itemsToDelete = sessions.filter((s) => selectedItems.has(s.session_id));
    await Promise.all(
      itemsToDelete.map((s) => apiClient.sessions.deleteSession(s.session_id, username))
    );
    setSelectedItems(new Set());
    setShowModalDelete(false);
    await getSessions();
    setIsLoading(false);
  };

  const deleteUserSessions = async () => {
    if (!appContext) return;

    setIsLoading(true);
    const apiClient = new ApiClient(appContext);
    await getSessions();
    setIsLoading(false);
  };

  const handleSelectAll = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.checked) {
      setSelectedItems(new Set(sessions.map((s) => s.session_id)));
    } else {
      setSelectedItems(new Set());
    }
  };

  const handleSelectItem = (sessionId: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  };

  const handleRequestSort = (property: string) => {
    const isAsc = orderBy === property && order === "asc";
    setOrder(isAsc ? "desc" : "asc");
    setOrderBy(property);
  };

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      if (orderBy === "time_stamp") {
        const diff = new Date(b.time_stamp).getTime() - new Date(a.time_stamp).getTime();
        return order === "desc" ? diff : -diff;
      }
      if (orderBy === "title") {
        const aVal = (a.title || "").toLowerCase();
        const bVal = (b.title || "").toLowerCase();
        const cmp = aVal.localeCompare(bVal);
        return order === "asc" ? cmp : -cmp;
      }
      return 0;
    });
  }, [sessions, order, orderBy]);

  const paginatedSessions = useMemo(() => {
    return sortedSessions.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  }, [sortedSessions, page, rowsPerPage]);

  return (
    <>
      <Dialog
        open={showModalDelete}
        onClose={() => setShowModalDelete(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {"Delete session" + (selectedItems.size > 1 ? "s" : "")}
        </DialogTitle>
        <DialogContent>
          <Typography>
            Do you want to delete{" "}
            {selectedItems.size === 1
              ? `session ${[...selectedItems][0]}?`
              : `${selectedItems.size} sessions?`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModalDelete(false)}>
            Cancel
          </Button>
          <Button variant="contained" onClick={deleteSelectedSessions}>
            Ok
          </Button>
        </DialogActions>
      </Dialog>

      <Box>
        <Typography variant="h4" sx={{ mb: 3 }}>Session History</Typography>

        <Stack direction="row" spacing={1} sx={{ mb: 2 }} alignItems="center">
          <RouterButton
            href={`/chatbot/playground/${uuidv4()}`}
            startIcon={<AddIcon />}
            variant="outlined"
            size="small"
          >
            New session
          </RouterButton>
          <Button
            startIcon={<RefreshIcon />}
            onClick={() => getSessions()}
            size="small"
          >
            Refresh
          </Button>
          <Button
            disabled={selectedItems.size === 0}
            startIcon={<DeleteIcon />}
            onClick={() => {
              if (selectedItems.size > 0) setShowModalDelete(true);
            }}
            size="small"
            color="error"
          >
            Delete
          </Button>
        </Stack>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          View or delete any of your past 100 sessions
        </Typography>

        <TableContainer component={Paper}>
          <Table size="small" aria-label="Session history">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    indeterminate={selectedItems.size > 0 && selectedItems.size < sessions.length}
                    checked={sessions.length > 0 && selectedItems.size === sessions.length}
                    onChange={handleSelectAll}
                    aria-label="Select all sessions"
                  />
                </TableCell>
                <TableCell>
                  <TableSortLabel
                    active={orderBy === "title"}
                    direction={orderBy === "title" ? order : "asc"}
                    onClick={() => handleRequestSort("title")}
                  >
                    Title
                  </TableSortLabel>
                </TableCell>
                <TableCell>
                  <TableSortLabel
                    active={orderBy === "time_stamp"}
                    direction={orderBy === "time_stamp" ? order : "asc"}
                    onClick={() => handleRequestSort("time_stamp")}
                  >
                    Time
                  </TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                    <CircularProgress size={24} />
                    <Typography variant="body2" sx={{ mt: 1 }}>Loading history</Typography>
                  </TableCell>
                </TableRow>
              ) : paginatedSessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                    <Typography variant="body2"><strong>No sessions</strong></Typography>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedSessions.map((session) => (
                  <TableRow
                    key={session.session_id}
                    hover
                    selected={selectedItems.has(session.session_id)}
                  >
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={selectedItems.has(session.session_id)}
                        onChange={() => handleSelectItem(session.session_id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Link to={`/chatbot/playground/${session.session_id}`}>
                        {session.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {DateTime.fromISO(
                        new Date(session.time_stamp).toISOString()
                      ).toLocaleString(DateTime.DATETIME_SHORT)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <TablePagination
            rowsPerPageOptions={[10, 20, 50]}
            component="div"
            count={sessions.length}
            rowsPerPage={rowsPerPage}
            page={page}
            onPageChange={(_, newPage) => setPage(newPage)}
            onRowsPerPageChange={(e) => {
              setRowsPerPage(parseInt(e.target.value, 10));
              setPage(0);
            }}
          />
        </TableContainer>
      </Box>
    </>
  );
}
