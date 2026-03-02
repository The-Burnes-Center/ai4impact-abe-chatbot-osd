import { AdminDataType } from "../../common/types";
import { DateTime } from "luxon";
import { Utils } from "../../common/utils";
import { useNavigate } from "react-router-dom";
import { Button, Tooltip, Chip, Stack } from "@mui/material";
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

function scoreColor(pct: number): "success" | "warning" | "error" {
  if (pct >= 75) return "success";
  if (pct >= 50) return "warning";
  return "error";
}

function QualityChip({ value, label }: { value: number | undefined; label: string }) {
  if (value === undefined || value === null) return <span>N/A</span>;
  const pct = value * 100;
  return (
    <Tooltip title={label} placement="top" arrow>
      <Chip
        label={`${pct.toFixed(0)}%`}
        color={scoreColor(pct)}
        size="small"
        variant="outlined"
        sx={{ cursor: "help", fontWeight: "bold" }}
      />
    </Tooltip>
  );
}

function MetricColumnWithTooltip({ value, description }: { value: any; description: string }) {
  if (value === undefined || value === null) return <span>N/A</span>;
  const pct = parseFloat(value) * 100;
  return (
    <Tooltip title={description} placement="top" arrow>
      <Chip
        label={`${pct.toFixed(0)}%`}
        color={scoreColor(pct)}
        size="small"
        variant="outlined"
        sx={{ cursor: "help" }}
      />
    </Tooltip>
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
      header: "Answer Quality",
      cell: (item) => {
        const avg = ((item.average_correctness || 0) + (item.average_similarity || 0)) / 2;
        return (
          <Tooltip
            title={`Correctness: ${((item.average_correctness || 0) * 100).toFixed(0)}% | Similarity: ${((item.average_similarity || 0) * 100).toFixed(0)}%`}
            arrow
          >
            <Chip label={`${(avg * 100).toFixed(0)}%`} color={scoreColor(avg * 100)} size="small" variant="outlined" sx={{ fontWeight: "bold", cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "average_correctness",
      sortingComparator: numericSort("average_correctness"),
    },
    {
      id: "retrievalQuality",
      header: "Retrieval Quality",
      cell: (item) => {
        const avg = ((item.average_context_precision || 0) + (item.average_context_recall || 0)) / 2;
        return (
          <Tooltip
            title={`Precision: ${((item.average_context_precision || 0) * 100).toFixed(0)}% | Recall: ${((item.average_context_recall || 0) * 100).toFixed(0)}%`}
            arrow
          >
            <Chip label={`${(avg * 100).toFixed(0)}%`} color={scoreColor(avg * 100)} size="small" variant="outlined" sx={{ fontWeight: "bold", cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "average_context_precision",
      sortingComparator: numericSort("average_context_precision"),
    },
    {
      id: "responseQuality",
      header: "Response Quality",
      cell: (item) => {
        const avg = ((item.average_response_relevancy || 0) + (item.average_faithfulness || 0)) / 2;
        return (
          <Tooltip
            title={`Relevancy: ${((item.average_response_relevancy || 0) * 100).toFixed(0)}% | Faithfulness: ${((item.average_faithfulness || 0) * 100).toFixed(0)}%`}
            arrow
          >
            <Chip label={`${(avg * 100).toFixed(0)}%`} color={scoreColor(avg * 100)} size="small" variant="outlined" sx={{ fontWeight: "bold", cursor: "help" }} />
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
      header: "Answer",
      cell: (item) => {
        const avg = ((item.correctness || 0) + (item.similarity || 0)) / 2;
        return (
          <Tooltip title={`Correctness: ${((item.correctness || 0) * 100).toFixed(0)}% | Similarity: ${((item.similarity || 0) * 100).toFixed(0)}%`} arrow>
            <Chip label={`${(avg * 100).toFixed(0)}%`} color={scoreColor(avg * 100)} size="small" variant="outlined" sx={{ cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "correctness",
    },
    {
      id: "retrievalQ",
      header: "Retrieval",
      cell: (item) => {
        const avg = ((item.context_precision || 0) + (item.context_recall || 0)) / 2;
        return (
          <Tooltip title={`Precision: ${((item.context_precision || 0) * 100).toFixed(0)}% | Recall: ${((item.context_recall || 0) * 100).toFixed(0)}%`} arrow>
            <Chip label={`${(avg * 100).toFixed(0)}%`} color={scoreColor(avg * 100)} size="small" variant="outlined" sx={{ cursor: "help" }} />
          </Tooltip>
        );
      },
      sortingField: "context_precision",
    },
    {
      id: "responseQ",
      header: "Response",
      cell: (item) => {
        const avg = ((item.response_relevancy || 0) + (item.faithfulness || 0)) / 2;
        return (
          <Tooltip title={`Relevancy: ${((item.response_relevancy || 0) * 100).toFixed(0)}% | Faithfulness: ${((item.faithfulness || 0) * 100).toFixed(0)}%`} arrow>
            <Chip label={`${(avg * 100).toFixed(0)}%`} color={scoreColor(avg * 100)} size="small" variant="outlined" sx={{ cursor: "help" }} />
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
