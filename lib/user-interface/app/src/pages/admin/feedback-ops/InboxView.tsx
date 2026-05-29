import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Chip,
  IconButton,
  InputAdornment,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import RefreshIcon from "@mui/icons-material/Refresh";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import SearchIcon from "@mui/icons-material/Search";
import { FeedbackItem, InboxFilters, feedbackStatusChip, formatDate, itemNeedsTriage } from "./types";

const ISSUE_LABELS: Record<string, { label: string; color: "error" | "warning" | "info" | "default" }> = {
  retrieval_gap: { label: "Missing info", color: "warning" },
  grounding_error: { label: "Wrong answer", color: "error" },
  prompt_issue: { label: "Response style", color: "info" },
  answer_quality: { label: "Low quality", color: "warning" },
  product_bug: { label: "System bug", color: "error" },
};

type ViewFilter = "needs" | "helpful" | "all";

function plainPreview(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  // Strip the most common markdown noise so a one-line card preview reads cleanly.
  return (
    text
      .replace(/[#*_>`~]/g, "")
      .replace(/\[(\d+)\]/g, "")
      .replace(/\s+/g, " ")
      .trim() || fallback
  );
}

interface InboxViewProps {
  feedbackItems: FeedbackItem[];
  filters: InboxFilters;
  loadingFeedback: boolean;
  loadingMeta: boolean;
  onFiltersChange: (filters: InboxFilters) => void;
  onRefresh: () => Promise<void>;
}

function InboxSkeleton() {
  return (
    <Stack spacing={2}>
      <Skeleton variant="rounded" height={48} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={120} />
    </Stack>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <InboxOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {body}
      </Typography>
    </Paper>
  );
}

export default function InboxView(props: InboxViewProps) {
  const { feedbackItems, filters, loadingFeedback, loadingMeta, onFiltersChange, onRefresh } = props;
  const navigate = useNavigate();

  const [page, setPage] = useState(0);
  const [view, setView] = useState<ViewFilter>("needs");
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const pageSize = 25;

  const counts = useMemo(
    () => ({
      needs: feedbackItems.filter(itemNeedsTriage).length,
      helpful: feedbackItems.filter((i) => i.feedbackKind === "helpful").length,
      all: feedbackItems.length,
    }),
    [feedbackItems]
  );

  const visibleItems = useMemo(() => {
    if (view === "needs") return feedbackItems.filter(itemNeedsTriage);
    if (view === "helpful") return feedbackItems.filter((i) => i.feedbackKind === "helpful");
    return feedbackItems;
  }, [feedbackItems, view]);

  const totalPages = Math.ceil(visibleItems.length / pageSize);
  const pagedItems = useMemo(() => visibleItems.slice(page * pageSize, (page + 1) * pageSize), [visibleItems, page]);

  useEffect(() => {
    setPage(0);
  }, [view]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, Math.max(0, totalPages - 1)));
  }, [totalPages]);

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchDraft === filtersRef.current.search) return undefined;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      onFiltersChange({ ...filtersRef.current, search: searchDraft });
      setPage(0);
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchDraft, onFiltersChange]);

  if (loadingFeedback && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  const listBusy = loadingFeedback || loadingMeta;
  const openDetail = (id: string) => navigate(`/admin/user-feedback/${id}`);

  return (
    <Stack spacing={2}>
      {listBusy && (
        <Box role="progressbar" aria-label="Loading feedback" aria-busy="true" sx={{ borderRadius: 1 }}>
          <LinearProgress sx={{ borderRadius: 1 }} />
        </Box>
      )}

      {/* Simple controls: what to show + search */}
      <Stack direction={{ xs: "column", sm: "row" }} gap={1.5} alignItems={{ sm: "center" }} justifyContent="space-between">
        <ToggleButtonGroup
          value={view}
          exclusive
          size="small"
          onChange={(_, value: ViewFilter | null) => {
            if (value) setView(value);
          }}
          aria-label="Which feedback to show"
        >
          <ToggleButton value="needs" sx={{ textTransform: "none", px: 1.75 }}>
            Needs review{counts.needs > 0 ? ` (${counts.needs})` : ""}
          </ToggleButton>
          <ToggleButton value="helpful" sx={{ textTransform: "none", px: 1.75 }}>
            Helpful{counts.helpful > 0 ? ` (${counts.helpful})` : ""}
          </ToggleButton>
          <ToggleButton value="all" sx={{ textTransform: "none", px: 1.75 }}>
            All ({counts.all})
          </ToggleButton>
        </ToggleButtonGroup>

        <Stack direction="row" gap={1} alignItems="center" sx={{ flex: 1, maxWidth: { sm: 360 } }}>
          <TextField
            size="small"
            placeholder="Search feedback"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            sx={{ flex: 1 }}
            inputProps={{ "aria-label": "Search feedback" }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <Tooltip title="Refresh">
            <span>
              <IconButton onClick={onRefresh} disabled={listBusy} size="small" aria-label="Refresh">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {/* List */}
      {visibleItems.length === 0 ? (
        view === "needs" ? (
          <EmptyState
            title="Nothing needs your review"
            body="You're all caught up. Switch to “All” or “Helpful” to see other feedback."
          />
        ) : feedbackItems.length === 0 ? (
          <EmptyState title="No feedback yet" body="Feedback from chat users will show up here once they submit it." />
        ) : (
          <EmptyState title="No matches" body="Try a different search or filter." />
        )
      ) : (
        <Stack spacing={1.5} sx={{ maxWidth: 860 }} role="list" aria-label="Feedback">
          {pagedItems.map((item) => {
            const positive = item.feedbackKind === "helpful";
            const status = feedbackStatusChip(item);
            const issue = item.rootCause ? ISSUE_LABELS[item.rootCause] : undefined;
            const question = plainPreview(item.userPromptPreview, "(no question captured)");
            const preview = plainPreview(item.summary || item.answerPreview, "No preview available.");

            return (
              <Paper
                key={item.feedbackId}
                variant="outlined"
                component="article"
                role="listitem"
                tabIndex={0}
                onClick={() => openDetail(item.feedbackId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openDetail(item.feedbackId);
                  }
                }}
                aria-label={`${status.label}. ${question}`}
                sx={{
                  cursor: "pointer",
                  borderRadius: 2,
                  p: 2,
                  borderLeftWidth: 4,
                  borderLeftStyle: "solid",
                  borderLeftColor: positive ? "success.main" : "warning.main",
                  transition: "box-shadow 160ms ease",
                  "&:hover": { boxShadow: (t) => `0 6px 20px ${alpha(t.palette.common.black, 0.08)}` },
                  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
                }}
              >
                <Stack spacing={1}>
                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                    {positive ? (
                      <ThumbUpOutlinedIcon sx={{ fontSize: 18, color: "success.main" }} aria-hidden />
                    ) : (
                      <ThumbDownOutlinedIcon sx={{ fontSize: 18, color: "warning.dark" }} aria-hidden />
                    )}
                    <Chip size="small" color={status.color} label={status.label} sx={{ height: 22, fontSize: "0.75rem" }} />
                    {issue && (
                      <Chip
                        size="small"
                        variant="outlined"
                        color={issue.color}
                        label={issue.label}
                        sx={{ height: 22, fontSize: "0.75rem" }}
                      />
                    )}
                    {item.recurrenceCount && item.recurrenceCount > 1 && (
                      <Chip size="small" variant="outlined" label={`Seen ${item.recurrenceCount}×`} sx={{ height: 22, fontSize: "0.75rem" }} />
                    )}
                    <Box sx={{ flex: 1 }} />
                    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                      {formatDate(item.createdAt)}
                    </Typography>
                  </Stack>

                  <Typography
                    sx={{
                      fontWeight: 600,
                      fontSize: "0.95rem",
                      lineHeight: 1.4,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {question}
                  </Typography>

                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      fontSize: "0.8125rem",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {preview}
                  </Typography>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ maxWidth: 860, pt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Page {page + 1} of {totalPages}
          </Typography>
          <Stack direction="row" gap={0.5}>
            <IconButton size="small" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page">
              <NavigateBeforeIcon />
            </IconButton>
            <IconButton
              size="small"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <NavigateNextIcon />
            </IconButton>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
