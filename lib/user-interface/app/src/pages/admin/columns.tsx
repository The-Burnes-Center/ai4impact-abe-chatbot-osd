import { ReactNode } from "react";
import { AdminDataType } from "../../common/types";
import { DateTime } from "luxon";
import { Utils } from "../../common/utils";
import { useNavigate } from "react-router-dom";
import { Button, Tooltip, Chip, Stack, Typography, Box } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { TruncatedTextCell } from "../../components/truncated-text-call";

export interface ColumnDefinition {
  id: string;
  header: ReactNode;
  cell: (item: any) => any;
  sortingField?: string;
  sortingComparator?: (a: any, b: any) => number;
  width?: string;
  disableSort?: boolean;
}

export const METRIC_DESCRIPTIONS = {
  answerQuality: {
    short: "Are the chatbot's answers correct? High = answers match your expected responses. Low = answers differ -- this could mean the chatbot is wrong, or your test Q&A may be outdated if documents have changed.",
    detail: "Compares the chatbot's answers against the expected responses in your test file. High scores mean strong alignment. Low scores could mean the chatbot is giving wrong answers, but also check whether your expected responses are still accurate -- if your source documents have been updated, the \"correct\" answers in your test file may be outdated and need refreshing.",
  },
  retrievalQuality: {
    short: "Is the chatbot finding the right documents? High = relevant sources retrieved. Low = wrong or missing documents -- consider if new documents were added or old ones removed.",
    detail: "Measures how well the chatbot searches your knowledge base. High scores mean it pulls the right documents for each question. Low scores could mean your documents are missing content on certain topics, are poorly structured, or were recently reorganized. If you've added or changed documents, re-run the evaluation to see if retrieval improves.",
  },
  responseQuality: {
    short: "Is the response trustworthy? High = on-topic, evidence-based answers. Low = off-topic or unsupported claims -- especially important to monitor after document changes.",
    detail: "Measures whether the chatbot stays on-topic and only says things supported by your documents. High scores mean reliable responses. Low scores mean the chatbot may be going off-topic or making claims not found in any document. After updating documents, this metric helps verify the chatbot hasn't started hallucinating on topics where content changed.",
  },
  correctness: "High = the chatbot's facts align with your expected answer. Low = facts differ -- the chatbot may be wrong, or your expected answer may need updating if the source documents have changed since the test file was created.",
  similarity: "High = the chatbot's answer conveys the same meaning as expected. Low = the meaning has diverged -- compare the actual vs. expected columns to determine if the chatbot is off or if the expected response needs refreshing.",
  contextPrecision: "High = the retrieved documents are relevant to the question. Low = irrelevant documents are being pulled. Check if your documents are clearly titled and well-organized, or if recently added documents are causing noise.",
  contextRecall: "High = the retrieved documents contain enough info to fully answer the question. Low = key information is missing from retrieved results. You may need to add source documents covering these topics, or the existing documents may have been modified.",
  responseRelevancy: "High = the answer directly addresses the question. Low = the response goes off-topic or includes unrelated information. This can happen when retrieved documents cover similar but not identical topics.",
  faithfulness: "High = every claim in the answer is supported by a retrieved document. Low = the chatbot is generating information not found in your documents. This is the most critical trust metric -- low scores here mean users could receive made-up information.",
};

function scoreColor(pct: number): "success" | "warning" | "error" {
  if (pct >= 75) return "success";
  if (pct >= 50) return "warning";
  return "error";
}

function HeaderWithInfo({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <Tooltip
      title={<Typography variant="body2" sx={{ p: 0.5 }}>{tooltip}</Typography>}
      placement="top"
      arrow
      enterDelay={200}
    >
      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, cursor: "help" }}>
        {label}
        <InfoOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />
      </Box>
    </Tooltip>
  );
}

function scoreLabel(pct: number): string {
  if (pct >= 75) return "Good";
  if (pct >= 50) return "Needs improvement";
  return "Poor";
}

function CellTooltipContent({ metrics }: { metrics: { label: string; pct: number; hint: string }[] }) {
  return (
    <Box sx={{ p: 0.5 }}>
      {metrics.map((m) => (
        <Typography key={m.label} variant="body2" sx={{ mb: 0.5 }}>
          <strong>{m.label}: {m.pct.toFixed(0)}%</strong> ({scoreLabel(m.pct)})
          <br />
          <span style={{ opacity: 0.85, fontSize: "0.85em" }}>{m.hint}</span>
        </Typography>
      ))}
    </Box>
  );
}

export function getColumnDefinition(
  documentType: AdminDataType,
  onProblemClick: (item: any) => void
): ColumnDefinition[] {
  function ViewDetailsButton({ evaluationId, evalName }: { evaluationId: string; evalName?: string }) {
    const navigate = useNavigate();
    const qs = evalName ? `?name=${encodeURIComponent(evalName)}` : "";
    return (
      <Button
        onClick={() => navigate(`/admin/llm-evaluation/details/${evaluationId}${qs}`)}
        variant="text"
        size="small"
      >
        View
      </Button>
    );
  }

  const numericSort = (field: string) => (a: any, b: any) => {
    const aVal = parseFloat(a[field]) || 0;
    const bVal = parseFloat(b[field]) || 0;
    return aVal - bVal;
  };

  const EVAL_SUMMARY_COLUMN_DEFINITIONS: ColumnDefinition[] = [
    {
      id: "evaluationName",
      header: "Name",
      cell: (item) => (
        <TruncatedTextCell text={item.evaluation_name || "Unnamed"} maxLength={40} />
      ),
    },
    {
      id: "timestamp",
      header: "Date",
      cell: (item) =>
        DateTime.fromISO(new Date(item.Timestamp).toISOString()).toLocaleString(
          DateTime.DATETIME_SHORT
        ),
      sortingField: "Timestamp",
      sortingComparator: (a, b) =>
        new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime(),
    },
    {
      id: "answerQuality",
      header: <HeaderWithInfo label="Answer Quality" tooltip={METRIC_DESCRIPTIONS.answerQuality.short} />,
      cell: (item) => {
        const corr = (item.average_correctness || 0) * 100;
        const sim = (item.average_similarity || 0) * 100;
        const avg = (corr + sim) / 2;
        return (
          <Tooltip
            title={<CellTooltipContent metrics={[
              { label: "Correctness", pct: corr, hint: corr >= 75 ? "Answers align with expected responses" : corr >= 50 ? "Some answers differ from expected -- check if test Q&A is still current" : "Significant gaps -- either the chatbot or your test expected answers may need updating" },
              { label: "Similarity", pct: sim, hint: sim >= 75 ? "Meaning closely matches expected" : sim >= 50 ? "Partial match -- compare actual vs. expected to see what diverged" : "Answers convey different meaning -- review if documents or test data changed" },
            ]} />}
            arrow
          >
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ fontWeight: "bold", cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "average_correctness",
      sortingComparator: numericSort("average_correctness"),
    },
    {
      id: "retrievalQuality",
      header: <HeaderWithInfo label="Retrieval Quality" tooltip={METRIC_DESCRIPTIONS.retrievalQuality.short} />,
      cell: (item) => {
        const prec = (item.average_context_precision || 0) * 100;
        const rec = (item.average_context_recall || 0) * 100;
        const avg = (prec + rec) / 2;
        return (
          <Tooltip
            title={<CellTooltipContent metrics={[
              { label: "Precision", pct: prec, hint: prec >= 75 ? "Retrieved documents are relevant" : prec >= 50 ? "Some unrelated documents pulled -- check document titles and structure" : "Mostly irrelevant documents -- reorganize or re-title source content" },
              { label: "Recall", pct: rec, hint: rec >= 75 ? "Key information is being found" : rec >= 50 ? "Some info missing -- check if documents were recently changed or removed" : "Critical content not found -- add or restore source documents on these topics" },
            ]} />}
            arrow
          >
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ fontWeight: "bold", cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "average_context_precision",
      sortingComparator: numericSort("average_context_precision"),
    },
    {
      id: "responseQuality",
      header: <HeaderWithInfo label="Response Quality" tooltip={METRIC_DESCRIPTIONS.responseQuality.short} />,
      cell: (item) => {
        const rel = (item.average_response_relevancy || 0) * 100;
        const faith = (item.average_faithfulness || 0) * 100;
        const avg = (rel + faith) / 2;
        return (
          <Tooltip
            title={<CellTooltipContent metrics={[
              { label: "Relevancy", pct: rel, hint: rel >= 75 ? "Answers directly address the question" : rel >= 50 ? "Some answers stray off-topic" : "Answers frequently miss the point -- review these questions individually" },
              { label: "Faithfulness", pct: faith, hint: faith >= 75 ? "Answers are grounded in source documents" : faith >= 50 ? "Some claims lack document support -- verify after document changes" : "Hallucination risk -- chatbot is generating unsupported claims" },
            ]} />}
            arrow
          >
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ fontWeight: "bold", cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "average_faithfulness",
      sortingComparator: numericSort("average_faithfulness"),
    },
    {
      id: "totalQuestions",
      header: "Q&A",
      cell: (item) => item.total_questions || "—",
      width: "60px",
    },
    {
      id: "viewDetails",
      header: "",
      cell: (item) => <ViewDetailsButton evaluationId={item.EvaluationId} evalName={item.evaluation_name} />,
      disableSort: true,
      width: "80px",
    },
  ];

  const DETAILED_EVAL_COLUMN_DEFINITIONS: ColumnDefinition[] = [
    {
      id: "question",
      header: "Question",
      cell: (item) => (
        <TruncatedTextCell text={item.question || "N/A"} maxLength={50} />
      ),
    },
    {
      id: "expectedResponse",
      header: "Expected",
      cell: (item) => (
        <TruncatedTextCell text={item.expected_response || "N/A"} maxLength={40} />
      ),
    },
    {
      id: "actualResponse",
      header: "Actual",
      cell: (item) => (
        <TruncatedTextCell text={item.actual_response || "N/A"} maxLength={40} />
      ),
    },
    {
      id: "answerQ",
      header: <HeaderWithInfo label="Answer" tooltip={METRIC_DESCRIPTIONS.answerQuality.short} />,
      cell: (item) => {
        const corr = (item.correctness || 0) * 100;
        const sim = (item.similarity || 0) * 100;
        const avg = (corr + sim) / 2;
        return (
          <Tooltip title={<CellTooltipContent metrics={[
            { label: "Correctness", pct: corr, hint: corr >= 75 ? "Chatbot's facts match expected answer" : corr >= 50 ? "Some facts differ -- compare Expected vs. Actual columns" : "Major differences -- check if expected answer is still accurate" },
            { label: "Similarity", pct: sim, hint: sim >= 75 ? "Meaning closely aligns" : sim >= 50 ? "Partial match -- wording or scope may differ" : "Very different meaning -- expected answer may need updating" },
          ]} />} arrow>
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "correctness",
    },
    {
      id: "retrievalQ",
      header: <HeaderWithInfo label="Retrieval" tooltip={METRIC_DESCRIPTIONS.retrievalQuality.short} />,
      cell: (item) => {
        const prec = (item.context_precision || 0) * 100;
        const rec = (item.context_recall || 0) * 100;
        const avg = (prec + rec) / 2;
        return (
          <Tooltip title={<CellTooltipContent metrics={[
            { label: "Precision", pct: prec, hint: prec >= 75 ? "Relevant docs retrieved" : prec >= 50 ? "Some unrelated docs pulled" : "Wrong documents retrieved -- topic may lack clear source content" },
            { label: "Recall", pct: rec, hint: rec >= 75 ? "All needed info found" : rec >= 50 ? "Partial info -- some source content may be missing" : "Key content not found -- check if documents were changed or removed" },
          ]} />} arrow>
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "context_precision",
    },
    {
      id: "responseQ",
      header: <HeaderWithInfo label="Response" tooltip={METRIC_DESCRIPTIONS.responseQuality.short} />,
      cell: (item) => {
        const rel = (item.response_relevancy || 0) * 100;
        const faith = (item.faithfulness || 0) * 100;
        const avg = (rel + faith) / 2;
        return (
          <Tooltip title={<CellTooltipContent metrics={[
            { label: "Relevancy", pct: rel, hint: rel >= 75 ? "Directly answers the question" : rel >= 50 ? "Partially on-topic -- may include tangential info" : "Off-topic -- chatbot may be confused by similar documents" },
            { label: "Faithfulness", pct: faith, hint: faith >= 75 ? "Claims supported by source documents" : faith >= 50 ? "Some claims lack document support" : "Unsupported claims present -- verify source documents exist for this topic" },
          ]} />} arrow>
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "faithfulness",
    },
    {
      id: "retrievedContext",
      header: "Retrieved context",
      cell: (item) => (
        <Tooltip title="Preview of retrieved KB chunks (source and relevance in full view).">
          <span>
            <TruncatedTextCell text={item.retrieved_context || "N/A"} maxLength={40} />
          </span>
        </Tooltip>
      ),
    },
  ];

  const FEEDBACK_COLUMN_DEFINITIONS: ColumnDefinition[] = [
    {
      id: "problem",
      header: "Problem",
      cell: (item) => (
        <Button onClick={() => onProblemClick(item)} variant="text" size="small">
          {item.Problem}
        </Button>
      ),
    },
    { id: "topic", header: "Topic", cell: (item) => item.Topic },
    {
      id: "createdAt",
      header: "Submission date",
      cell: (item) =>
        DateTime.fromISO(new Date(item.CreatedAt).toISOString()).toLocaleString(
          DateTime.DATETIME_SHORT
        ),
    },
    { id: "prompt", header: "User Prompt", cell: (item) => item.UserPrompt },
  ];

  const FILES_COLUMN_DEFINITIONS: ColumnDefinition[] = [
    { id: "name", header: "Name", cell: (item) => item.Key },
    {
      id: "createdAt",
      header: "Upload date",
      cell: (item) =>
        DateTime.fromISO(new Date(item.LastModified).toISOString()).toLocaleString(
          DateTime.DATETIME_SHORT
        ),
    },
    { id: "size", header: "Size", cell: (item) => Utils.bytesToSize(item.Size) },
  ];

  switch (documentType) {
    case "file":
      return FILES_COLUMN_DEFINITIONS;
    case "feedback":
      return FEEDBACK_COLUMN_DEFINITIONS;
    case "evaluationSummary":
      return EVAL_SUMMARY_COLUMN_DEFINITIONS;
    case "detailedEvaluation":
      return DETAILED_EVAL_COLUMN_DEFINITIONS;
    default:
      return [];
  }
}
