import { AdminDataType } from "../../common/types";
import { DateTime } from "luxon";
import { Utils } from "../../common/utils";
import { useNavigate } from 'react-router-dom';
import { Button, Popover } from "@cloudscape-design/components";
import { TruncatedTextCell } from "../../components/truncated-text-call";

// Helper component for metric columns with tooltips
function MetricColumnWithTooltip({ value, description }) {
  if (value === undefined || value === null) return "N/A";
  const displayValue = parseFloat(value).toFixed(2);
  
  return (
    <Popover
      dismissAriaLabel="Close"
      position="top"
      size="medium"
      content={description}
      triggerType="custom"
    >
      <span style={{ cursor: 'help', borderBottom: '1px dotted #888' }}>
        {displayValue}
      </span>
    </Popover>
  );
}

export function getColumnDefinition(documentType: AdminDataType, onProblemClick: (item: any) => void) {
  function ViewDetailsButton({ evaluationId }) {
  const navigate = useNavigate();
  console.log("evaluationId: ", evaluationId);

  const viewDetailedEvaluation = (evaluationId) => {
    navigate(`/admin/llm-evaluation/${evaluationId}`);
  };

  return (
    <Button onClick={() => viewDetailedEvaluation(evaluationId)} variant="link">
      View Details
    </Button>
  );
}

const EVAL_SUMMARY_COLUMN_DEFINITIONS = [
  { 
    id: "evaluationName",
    header: "Evaluation Name",
    cell: (item) => <TruncatedTextCell text={item.evaluation_name || "Unnamed Evaluation"} maxLength={50}/>
  },
  {
    id: "evalTestCaseKey",
    header: "Test Case Filename",
    cell: (item) => <TruncatedTextCell text={item.test_cases_key || "Unnamed Test Case"} maxLength={50}/>
  },
  {
    id: "timestamp",
    header: "Timestamp",
    //cell: (item) => new Date(item.timestamp).toLocaleString(),
    cell: (item) =>
      DateTime.fromISO(new Date(item.Timestamp).toISOString()).toLocaleString(
        DateTime.DATETIME_SHORT
      ),
    sortingField: "Timestamp",
    sortingComparator: (a, b) => new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime()
  },
  {
    id: "averageSimilarity",
    header: "Average Similarity",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_similarity,
      description: "Semantic similarity between chatbot response and reference answer (0-1)"
    }),
    sortingField: "average_similarity",
    sortingComparator: (a, b) => {
      const aVal = a.average_similarity === undefined || a.average_similarity === null ? 0 : parseFloat(a.average_similarity);
      const bVal = b.average_similarity === undefined || b.average_similarity === null ? 0 : parseFloat(b.average_similarity);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true
  },
  {
    id: "averageRelevance",
    header: "Average Relevance",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_relevance,
      description: "How relevant the response is to the original question (0-1)"
    }),
    sortingField: "average_relevance",
    sortingComparator: (a, b) => {
      const aVal = a.average_relevance === undefined || a.average_relevance === null ? 0 : parseFloat(a.average_relevance);
      const bVal = b.average_relevance === undefined || b.average_relevance === null ? 0 : parseFloat(b.average_relevance);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true
  },
  {
    id: "averageCorrectness",
    header: "Average Correctness",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_correctness,
      description: "F1-score combining precision and recall between response and reference answer (0-1)"
    }),
    sortingField: "average_correctness",
    sortingComparator: (a, b) => {
      const aVal = a.average_correctness === undefined || a.average_correctness === null ? 0 : parseFloat(a.average_correctness);
      const bVal = b.average_correctness === undefined || b.average_correctness === null ? 0 : parseFloat(b.average_correctness);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true 
  },
  // New RAG metrics
  {
    id: "averageContextPrecision",
    header: "Context Precision",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_context_precision,
      description: "How relevant/precise the retrieved context is to the question - measures if the retrieved chunks are focused and relevant (0-1)"
    }),
    sortingField: "average_context_precision",
    sortingComparator: (a, b) => {
      const aVal = a.average_context_precision === undefined || a.average_context_precision === null ? 0 : parseFloat(a.average_context_precision);
      const bVal = b.average_context_precision === undefined || b.average_context_precision === null ? 0 : parseFloat(b.average_context_precision);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true 
  },
  {
    id: "averageContextRecall",
    header: "Context Recall",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_context_recall,
      description: "How well the retrieved context covers the information needed for a correct answer - measures if all necessary information was retrieved (0-1)"
    }),
    sortingField: "average_context_recall",
    sortingComparator: (a, b) => {
      const aVal = a.average_context_recall === undefined || a.average_context_recall === null ? 0 : parseFloat(a.average_context_recall);
      const bVal = b.average_context_recall === undefined || b.average_context_recall === null ? 0 : parseFloat(b.average_context_recall);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true 
  },
  {
    id: "averageResponseRelevancy",
    header: "Response Relevancy",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_response_relevancy,
      description: "How relevant the response is to the original question - measures if the response directly addresses what was asked (0-1)"
    }),
    sortingField: "average_response_relevancy",
    sortingComparator: (a, b) => {
      const aVal = a.average_response_relevancy === undefined || a.average_response_relevancy === null ? 0 : parseFloat(a.average_response_relevancy);
      const bVal = b.average_response_relevancy === undefined || b.average_response_relevancy === null ? 0 : parseFloat(b.average_response_relevancy);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true 
  },
  {
    id: "averageFaithfulness",
    header: "Faithfulness",
    cell: (item) => MetricColumnWithTooltip({
      value: item.average_faithfulness,
      description: "How faithful/grounded the response is to the retrieved context - measures if the response contains only information from the context without hallucination (0-1)"
    }),
    sortingField: "average_faithfulness",
    sortingComparator: (a, b) => {
      const aVal = a.average_faithfulness === undefined || a.average_faithfulness === null ? 0 : parseFloat(a.average_faithfulness);
      const bVal = b.average_faithfulness === undefined || b.average_faithfulness === null ? 0 : parseFloat(b.average_faithfulness);
      return aVal - bVal;
    },
    width: "10%",
    wrapText: true 
  },
  {
    id: "viewDetails",
    header: "View Details",
    cell: (item) => <ViewDetailsButton evaluationId={item.EvaluationId}/>,
    disableSort: true
  }, 
];


const DETAILED_EVAL_COLUMN_DEFINITIONS = [
  {
    id: "question",
    header: "Question",
    cell: (item) => <TruncatedTextCell text={item.question || "No question available"} maxLength={50}/>
  },
  {
    id: "expectedResponse",
    header: "Expected Response",
    cell: (item) => <TruncatedTextCell text={item.expected_response || "No expected response available"} maxLength={50}/>
  },
  {
    id: "actualResponse",
    header: "Actual Response",
    cell: (item) => <TruncatedTextCell text={item.actual_response || "No actual response available"} maxLength={50}/>
  },
  {
    id: "similarity",
    header: "Similarity",
    cell: (item) => MetricColumnWithTooltip({
      value: item.similarity,
      description: "Semantic similarity between chatbot response and reference answer (0-1)"
    }),
    sortingField: "similarity"
  },
  {
    id: "relevance",
    header: "Relevance",
    cell: (item) => MetricColumnWithTooltip({
      value: item.relevance,
      description: "How relevant the response is to the original question (0-1)"
    }),
    sortingField: "relevance"
  },
  {
    id: "correctness",
    header: "Correctness",
    cell: (item) => MetricColumnWithTooltip({
      value: item.correctness,
      description: "F1-score combining precision and recall between response and reference answer (0-1)"
    }),
    sortingField: "correctness"
  },
  // New RAG metrics for detailed evaluation
  {
    id: "contextPrecision",
    header: "Context Precision",
    cell: (item) => MetricColumnWithTooltip({
      value: item.context_precision,
      description: "How relevant/precise the retrieved context is to the question - measures if the retrieved chunks are focused and relevant (0-1)"
    }),
    sortingField: "context_precision"
  },
  {
    id: "contextRecall",
    header: "Context Recall",
    cell: (item) => MetricColumnWithTooltip({
      value: item.context_recall,
      description: "How well the retrieved context covers the information needed for a correct answer - measures if all necessary information was retrieved (0-1)"
    }),
    sortingField: "context_recall"
  },
  {
    id: "responseRelevancy",
    header: "Response Relevancy",
    cell: (item) => MetricColumnWithTooltip({
      value: item.response_relevancy,
      description: "How relevant the response is to the original question - measures if the response directly addresses what was asked (0-1)"
    }),
    sortingField: "response_relevancy"
  },
  {
    id: "faithfulness",
    header: "Faithfulness",
    cell: (item) => MetricColumnWithTooltip({
      value: item.faithfulness, 
      description: "How faithful/grounded the response is to the retrieved context - measures if the response contains only information from the context without hallucination (0-1)"
    }),
    sortingField: "faithfulness"
  },
  // Optional: Add retrieved context column
  {
    id: "retrievedContext",
    header: "Retrieved Context",
    cell: (item) => <TruncatedTextCell text={item.retrieved_context || "No context available"} maxLength={50}/>,
    width: "15%"
  }
];
  
const FEEDBACK_COLUMN_DEFINITIONS = [
    {
      id: "problem",
      header: "Problem",
      cell: (item) => {
        return (
          <Button onClick={() => onProblemClick(item)} variant="link">
            {item.Problem}
          </Button>
        );
      },
      isRowHeader: true,
    },
    {
      id: "topic",
      header: "Topic",
      cell: (item) => item.Topic,
      isRowHeader: true,
    },
    {
      id: "createdAt",
      header: "Submission date",
      cell: (item) =>
        DateTime.fromISO(new Date(item.CreatedAt).toISOString()).toLocaleString(
          DateTime.DATETIME_SHORT
        ),
    },
    {
      id: "prompt",
      header: "User Prompt",
      cell: (item) => item.UserPrompt,
      isRowHeader: true
    },
  ];

  const FILES_COLUMN_DEFINITIONS = [
    {
      id: "name",
      header: "Name",
      cell: (item) => item.Key!,
      isRowHeader: true,
    },
    {
      id: "createdAt",
      header: "Upload date",
      cell: (item) =>
        DateTime.fromISO(new Date(item.LastModified).toISOString()).toLocaleString(
          DateTime.DATETIME_SHORT
        ),
    },
    {
      id: "size",
      header: "Size",
      cell: (item) => Utils.bytesToSize(item.Size!),
    },
  ];

  // Return appropriate column definitions based on document type
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



// const FILES_COLUMN_DEFINITIONS = [
//   {
//     id: "name",
//     header: "Name",
//     cell: (item) => item.Key!,
//     isRowHeader: true,
//   },
//   {
//     id: "createdAt",
//     header: "Upload date",
//     cell: (item) =>
//       DateTime.fromISO(new Date(item.LastModified).toISOString()).toLocaleString(
//         DateTime.DATETIME_SHORT
//       ),
//   },
//   {
//     id: "size",
//     header: "Size",
//     cell: (item) => Utils.bytesToSize(item.Size!),
//   },
// ];

// const FEEDBACK_COLUMN_DEFINITIONS = [
//   {
//     id: "problem",
//     header: "Problem",
//     // cell: (item) => item.Problem,
//     cell: (item) => {
//       return (
//         <Button onClick={() => onProblemClick(item)} variant="link">
//           {item.Problem}
//         </Button>
//       );
//     },
//     isRowHeader: true,
//   },
//   {
//     id: "topic",
//     header: "Topic",
//     cell: (item) => item.Topic,
//     isRowHeader: true,
//   },
//   {
//     id: "createdAt",
//     header: "Submission date",
//     cell: (item) =>
//       DateTime.fromISO(new Date(item.CreatedAt).toISOString()).toLocaleString(
//         DateTime.DATETIME_SHORT
//       ),
//   },
//   {
//     id: "prompt",
//     header: "User Prompt",
//     cell: (item) => item.UserPrompt,
//     isRowHeader: true
//   },

// ];

// /** This is exposed as a function because the code that this is based off of
//  * originally supported many more distinct file types.
//  */
// export function getColumnDefinition(documentType: AdminDataType, onProblemClick: (item: any) => void) {
//   switch (documentType) {
//     case "file":
//       return FILES_COLUMN_DEFINITIONS;   
//     case "feedback":
//       return FEEDBACK_COLUMN_DEFINITIONS;
//     default:
//       return [];
//   }
// }
