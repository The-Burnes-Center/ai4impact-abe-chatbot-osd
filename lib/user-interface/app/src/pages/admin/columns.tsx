import { AdminDataType } from "../../common/types";
import { DateTime } from "luxon";
import { Utils } from "../../common/utils";
import { useNavigate } from "react-router-dom";
import { Button, Tooltip, Chip, Stack, Typography, Box } from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { TruncatedTextCell } from "../../components/truncated-text-call";

export interface ColumnDefinition {
  id: string;
  header: string;
  cell: (item: any) => any;
  sortingField?: string;
  sortingComparator?: (a: any, b: any) => number;
  width?: string;
  disableSort?: boolean;
}

export const METRIC_DESCRIPTIONS = {
  answerQuality: {
    short: "Are the chatbot's answers correct? High = answers match expected responses. Low = answers contain errors or miss key information.",
    detail: "Measures how well the chatbot's answers match the expected responses you provided in your test file. High scores mean the chatbot is giving accurate, complete answers. Low scores mean the chatbot is producing incorrect or incomplete answers -- review the per-question breakdown to identify which topics need better source documents.",
  },
  retrievalQuality: {
    short: "Is the chatbot finding the right documents? High = pulling relevant sources. Low = missing or irrelevant documents.",
    detail: "Measures whether the chatbot is searching through your uploaded documents effectively. High scores mean it finds the right information to answer questions. Low scores mean it's either pulling irrelevant documents or missing key documents -- this usually means your knowledge base documents need to be updated, reorganized, or are missing content on certain topics.",
  },
  responseQuality: {
    short: "Is the chatbot's response trustworthy? High = on-topic, evidence-based. Low = off-topic or making things up.",
    detail: "Measures whether the chatbot stays on-topic and only says things supported by your documents. High scores mean the chatbot is reliable and grounded. Low scores mean it may be going off-topic or generating claims not backed by any source document (hallucinating) -- this is the most critical metric for trust.",
  },
  correctness: "High = the chatbot's facts match the expected answer. Low = the chatbot is stating incorrect facts or missing important details. Review the source documents for these topics.",
  similarity: "High = the chatbot's answer conveys the same meaning as the expected answer. Low = the answer diverges in meaning, even if partially correct. Consider refining your knowledge base content.",
  contextPrecision: "High = the documents pulled by the chatbot are relevant to the question. Low = the chatbot is pulling unrelated documents, which may confuse its answers. Check if your documents are well-structured and clearly titled.",
  contextRecall: "High = the retrieved documents contain all the info needed to answer. Low = the chatbot can't find enough information in your documents. You may need to add more content covering these topics.",
  responseRelevancy: "High = the chatbot directly answers the question asked. Low = the chatbot goes off-topic or provides irrelevant information instead of addressing the user's question.",
  faithfulness: "High = every claim in the answer is backed by a source document. Low = the chatbot is making up information not found in your documents (hallucinating). This is critical -- low faithfulness means users may receive unreliable information.",
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
              { label: "Correctness", pct: corr, hint: corr >= 75 ? "Answers are factually accurate" : corr >= 50 ? "Some answers have factual gaps" : "Many answers contain incorrect facts" },
              { label: "Similarity", pct: sim, hint: sim >= 75 ? "Answers match expected meaning well" : sim >= 50 ? "Answers partially match expected meaning" : "Answers diverge significantly from expected" },
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
              { label: "Precision", pct: prec, hint: prec >= 75 ? "Retrieved documents are relevant" : prec >= 50 ? "Some irrelevant documents pulled" : "Many irrelevant documents -- review document structure" },
              { label: "Recall", pct: rec, hint: rec >= 75 ? "Key information is being found" : rec >= 50 ? "Some information is missing from results" : "Critical content not found -- add more source documents" },
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
              { label: "Relevancy", pct: rel, hint: rel >= 75 ? "Answers are on-topic" : rel >= 50 ? "Some answers stray from the question" : "Answers frequently miss the point of the question" },
              { label: "Faithfulness", pct: faith, hint: faith >= 75 ? "Answers are grounded in source documents" : faith >= 50 ? "Some claims not supported by documents" : "High hallucination risk -- chatbot is making up information" },
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
            { label: "Correctness", pct: corr, hint: corr >= 75 ? "Facts match expected answer" : corr >= 50 ? "Some facts are off" : "Answer has significant factual errors" },
            { label: "Similarity", pct: sim, hint: sim >= 75 ? "Meaning aligns well" : sim >= 50 ? "Partially aligned" : "Answer conveys different meaning" },
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
            { label: "Precision", pct: prec, hint: prec >= 75 ? "Relevant docs retrieved" : prec >= 50 ? "Some irrelevant docs" : "Mostly irrelevant docs pulled" },
            { label: "Recall", pct: rec, hint: rec >= 75 ? "All needed info found" : rec >= 50 ? "Some info missing" : "Key information not found" },
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
            { label: "Relevancy", pct: rel, hint: rel >= 75 ? "Directly answers the question" : rel >= 50 ? "Partially addresses the question" : "Off-topic response" },
            { label: "Faithfulness", pct: faith, hint: faith >= 75 ? "Grounded in documents" : faith >= 50 ? "Some unsupported claims" : "Contains hallucinated information" },
          ]} />} arrow>
            <Chip label={`${avg.toFixed(0)}%`} color={scoreColor(avg)} size="small" variant="outlined" sx={{ cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "faithfulness",
    },
    {
      id: "retrievedContext",
      header: "Context",
      cell: (item) => (
        <TruncatedTextCell text={item.retrieved_context || "N/A"} maxLength={40} />
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
