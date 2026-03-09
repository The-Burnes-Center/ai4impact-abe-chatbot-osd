import {
  useState,
  useEffect,
  useContext,
  useMemo,
  useCallback,
  useRef,
} from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  Alert,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import HistoryIcon from "@mui/icons-material/History";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import FileUploadIcon from "@mui/icons-material/FileUpload";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { useNotifications } from "../../components/notif-manager";
import { Utils } from "../../common/utils";
import { TruncatedTextCell } from "../../components/truncated-text-call";

export default function TestLibraryTab() {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const { addNotification } = useNotifications();

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [stats, setStats] = useState<{ total: number; sources: any } | null>(null);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addQuestion, setAddQuestion] = useState("");
  const [addResponse, setAddResponse] = useState("");

  const [editItem, setEditItem] = useState<any>(null);
  const [editResponse, setEditResponse] = useState("");

  const [deleteItem, setDeleteItem] = useState<any>(null);

  const [historyItem, setHistoryItem] = useState<any>(null);
  const [historyData, setHistoryData] = useState<any>(null);

  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importResult, setImportResult] = useState<any>(null);

  const [exportAnchor, setExportAnchor] = useState<null | HTMLElement>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiClient.evaluations.listTestLibrary(search || undefined);
      setItems(result?.Items || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [apiClient, search]);

  const fetchStats = useCallback(async () => {
    try {
      const s = await apiClient.evaluations.getTestLibraryStats();
      setStats(s);
    } catch {
      setStats(null);
    }
  }, [apiClient]);

  useEffect(() => {
    fetchItems();
    fetchStats();
  }, [fetchItems, fetchStats]);

  const handleAdd = async () => {
    if (!addQuestion.trim() || !addResponse.trim()) return;
    try {
      const result = await apiClient.evaluations.createTestLibraryItem(
        addQuestion.trim(),
        addResponse.trim()
      );
      addNotification(
        "success",
        result.action === "updated" ? "Question existed - answer updated" : "Q&A pair added"
      );
      setAddDialogOpen(false);
      setAddQuestion("");
      setAddResponse("");
      fetchItems();
      fetchStats();
    } catch (err) {
      addNotification("error", Utils.getErrorMessage(err));
    }
  };

  const handleEdit = async () => {
    if (!editItem || !editResponse.trim()) return;
    try {
      await apiClient.evaluations.updateTestLibraryItem(editItem.QuestionId, editResponse.trim());
      addNotification("success", "Answer updated");
      setEditItem(null);
      fetchItems();
    } catch (err) {
      addNotification("error", Utils.getErrorMessage(err));
    }
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    try {
      await apiClient.evaluations.deleteTestLibraryItem(deleteItem.QuestionId);
      addNotification("success", "Q&A pair deleted");
      setDeleteItem(null);
      fetchItems();
      fetchStats();
    } catch (err) {
      addNotification("error", Utils.getErrorMessage(err));
    }
  };

  const handleViewHistory = async (item: any) => {
    try {
      const full = await apiClient.evaluations.getTestLibraryItem(item.QuestionId);
      setHistoryData(full);
      setHistoryItem(item);
    } catch {
      addNotification("error", "Failed to load version history");
    }
  };

  const handleRevert = async (versionIndex: number) => {
    if (!historyData) return;
    try {
      await apiClient.evaluations.revertTestLibraryItem(historyData.QuestionId, versionIndex);
      addNotification("success", "Reverted to previous version");
      setHistoryItem(null);
      setHistoryData(null);
      fetchItems();
    } catch (err) {
      addNotification("error", Utils.getErrorMessage(err));
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      let parsed: Array<{ question: string; expectedResponse: string }>;

      if (file.name.endsWith(".json")) {
        parsed = JSON.parse(text);
      } else if (file.name.endsWith(".csv")) {
        const lines = text.split("\n").filter((l) => l.trim());
        const header = lines[0].toLowerCase();
        const hasHeader = header.includes("question");
        const startIdx = hasHeader ? 1 : 0;
        parsed = lines.slice(startIdx).map((line) => {
          const [q, ...rest] = line.split(",");
          return { question: q?.trim().replace(/^"|"$/g, ""), expectedResponse: rest.join(",").trim().replace(/^"|"$/g, "") };
        });
      } else {
        addNotification("error", "Only .json and .csv files supported");
        return;
      }

      const result = await apiClient.evaluations.bulkImportTestLibrary(
        parsed,
        `upload:${file.name}`
      );
      setImportResult({ ...result, filename: file.name });
      setImportDialogOpen(true);
      fetchItems();
      fetchStats();
    } catch (err) {
      addNotification("error", `Import failed: ${Utils.getErrorMessage(err)}`);
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleExport = async (format: "json" | "csv") => {
    setExportAnchor(null);
    try {
      const result = await apiClient.evaluations.exportTestLibrary();
      const exportItems = result.items || [];

      if (format === "json") {
        const blob = new Blob([JSON.stringify(exportItems, null, 2)], { type: "application/json" });
        downloadBlob(blob, "test-library.json");
      } else {
        const csv =
          "\uFEFF" +
          "question,expectedResponse\n" +
          exportItems
            .map((i: any) => `"${(i.question || "").replace(/"/g, '""')}","${(i.expectedResponse || "").replace(/"/g, '""')}"`)
            .join("\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        downloadBlob(blob, "test-library.csv");
      }
    } catch (err) {
      addNotification("error", `Export failed: ${Utils.getErrorMessage(err)}`);
    }
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography variant="h6">Test Library</Typography>
          <Typography variant="body2" color="text.secondary">
            {stats ? `${stats.total} Q&A pairs` : "Loading..."}
            {stats?.sources?.manual ? ` | ${stats.sources.manual} manual` : ""}
            {stats?.sources?.upload ? ` | ${stats.sources.upload} from uploads` : ""}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <input
            type="file"
            ref={fileInputRef}
            accept=".json,.csv"
            onChange={handleImport}
            style={{ display: "none" }}
            aria-label="Choose file to import"
          />
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileUploadIcon />}
            onClick={() => fileInputRef.current?.click()}
          >
            Import
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadIcon />}
            onClick={(e) => setExportAnchor(e.currentTarget)}
          >
            Export
          </Button>
          <Menu
            anchorEl={exportAnchor}
            open={Boolean(exportAnchor)}
            onClose={() => setExportAnchor(null)}
          >
            <MenuItem onClick={() => handleExport("json")}>Export as JSON</MenuItem>
            <MenuItem onClick={() => handleExport("csv")}>Export as CSV</MenuItem>
          </Menu>
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setAddDialogOpen(true)}
          >
            Add
          </Button>
        </Stack>
      </Stack>

      <Paper sx={{ p: 1.5 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="Search questions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchItems()}
          InputProps={{
            startAdornment: <SearchIcon sx={{ mr: 1, color: "text.secondary" }} />,
            endAdornment: (
              <IconButton size="small" onClick={fetchItems} aria-label="Refresh search results">
                <RefreshIcon />
              </IconButton>
            ),
          }}
        />
      </Paper>

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress />
        </Box>
      ) : items.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: "center" }}>
          <Typography color="text.secondary">
            {search ? "No matching Q&A pairs found." : "Test library is empty. Add Q&A pairs to get started."}
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small" aria-label="Test library">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: "bold", width: "5%" }}>#</TableCell>
                <TableCell sx={{ fontWeight: "bold", width: "35%" }}>Question</TableCell>
                <TableCell sx={{ fontWeight: "bold", width: "35%" }}>Expected Response</TableCell>
                <TableCell sx={{ fontWeight: "bold", width: "12%" }}>Source</TableCell>
                <TableCell sx={{ fontWeight: "bold", width: "13%" }} align="right">
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item, idx) => (
                <TableRow key={item.QuestionId} hover>
                  <TableCell>{idx + 1}</TableCell>
                  <TableCell>
                    <TruncatedTextCell text={item.question || ""} maxLength={80} />
                  </TableCell>
                  <TableCell>
                    <TruncatedTextCell text={item.expectedResponse || ""} maxLength={80} />
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={item.source || "unknown"}
                      size="small"
                      variant="outlined"
                      color={item.source === "manual" ? "primary" : "default"}
                    />
                    {item.versionCount > 0 && (
                      <Chip
                        label={`${item.versionCount}v`}
                        size="small"
                        color="info"
                        variant="outlined"
                        sx={{ ml: 0.5 }}
                      />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit">
                      <IconButton
                        size="small"
                        aria-label="Edit test case"
                        onClick={() => {
                          setEditItem(item);
                          setEditResponse(item.expectedResponse || "");
                        }}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    {item.versionCount > 0 && (
                      <Tooltip title="Version history">
                        <IconButton size="small" aria-label="View version history" onClick={() => handleViewHistory(item)}>
                          <HistoryIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                    <Tooltip title="Delete">
                      <IconButton size="small" aria-label="Delete test case" onClick={() => setDeleteItem(item)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {/* Add Dialog */}
      <Dialog open={addDialogOpen} onClose={() => setAddDialogOpen(false)} maxWidth="sm" fullWidth aria-labelledby="add-qa-dialog-title">
        <DialogTitle id="add-qa-dialog-title">Add Q&A Pair</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="Question"
              multiline
              rows={2}
              value={addQuestion}
              onChange={(e) => setAddQuestion(e.target.value)}
              fullWidth
            />
            <TextField
              label="Expected Response"
              multiline
              rows={4}
              value={addResponse}
              onChange={(e) => setAddResponse(e.target.value)}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleAdd} disabled={!addQuestion.trim() || !addResponse.trim()}>
            Add
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editItem} onClose={() => setEditItem(null)} maxWidth="sm" fullWidth aria-labelledby="edit-qa-dialog-title">
        <DialogTitle id="edit-qa-dialog-title">Edit Expected Response</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Typography variant="subtitle2">Question:</Typography>
            <Typography variant="body2" color="text.secondary">
              {editItem?.question}
            </Typography>
            <TextField
              label="Expected Response"
              multiline
              rows={4}
              value={editResponse}
              onChange={(e) => setEditResponse(e.target.value)}
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditItem(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleEdit}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteItem} onClose={() => setDeleteItem(null)} aria-labelledby="delete-qa-dialog-title">
        <DialogTitle id="delete-qa-dialog-title">Delete Q&A Pair</DialogTitle>
        <DialogContent>
          <Typography>Are you sure you want to delete this Q&A pair?</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {deleteItem?.question}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteItem(null)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* History Dialog */}
      <Dialog
        open={!!historyItem}
        onClose={() => {
          setHistoryItem(null);
          setHistoryData(null);
        }}
        maxWidth="md"
        fullWidth
        aria-labelledby="version-history-dialog-title"
      >
        <DialogTitle id="version-history-dialog-title">Version History</DialogTitle>
        <DialogContent>
          {historyData ? (
            <Stack spacing={2}>
              <Box>
                <Typography variant="subtitle2">Question:</Typography>
                <Typography variant="body2">{historyData.question}</Typography>
              </Box>
              <Divider />
              <Box>
                <Typography variant="subtitle2" gutterBottom>
                  Current Answer:
                </Typography>
                <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "#f0fef0" }}>
                  <Typography variant="body2">{historyData.expectedResponse}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    Source: {historyData.source} | Updated: {historyData.updatedAt}
                  </Typography>
                </Paper>
              </Box>
              {historyData.versions?.length > 0 && (
                <>
                  <Divider />
                  <Typography variant="subtitle2">Previous Versions:</Typography>
                  {historyData.versions.map((v: any, i: number) => (
                    <Paper key={i} variant="outlined" sx={{ p: 1.5 }}>
                      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                        <Box sx={{ flex: 1 }}>
                          <Typography variant="body2">{v.expectedResponse}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            Source: {v.source} | Date: {v.updatedAt}
                          </Typography>
                        </Box>
                        <Button size="small" variant="outlined" onClick={() => handleRevert(i)}>
                          Revert
                        </Button>
                      </Stack>
                    </Paper>
                  ))}
                </>
              )}
            </Stack>
          ) : (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress />
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setHistoryItem(null);
              setHistoryData(null);
            }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Import Result Dialog */}
      <Dialog open={importDialogOpen} onClose={() => setImportDialogOpen(false)} aria-labelledby="import-result-dialog-title">
        <DialogTitle id="import-result-dialog-title">Import Complete</DialogTitle>
        <DialogContent>
          {importResult && (
            <Stack spacing={1}>
              <Typography>
                Imported from <strong>{importResult.filename}</strong>
              </Typography>
              <Stack direction="row" spacing={2}>
                <Chip label={`${importResult.added} added`} color="success" />
                <Chip label={`${importResult.updated} updated`} color="warning" />
                <Chip label={`${importResult.unchanged} unchanged`} color="default" />
              </Stack>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportDialogOpen(false)} variant="contained">
            OK
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
