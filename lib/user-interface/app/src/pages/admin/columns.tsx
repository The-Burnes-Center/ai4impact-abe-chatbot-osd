import { AdminDataType } from "../../common/types";
import { DateTime } from "luxon";
import { Utils } from "../../common/utils";
import { useNavigate } from 'react-router-dom';
import { Button } from "@cloudscape-design/components";
import { TruncatedTextCell } from "../../components/truncated-text-call";


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
    cell: (item) => {
      const value = item.average_similarity;
      if (value === undefined || value === null) return "N/A";
      return parseFloat(value).toFixed(2);
    },
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
    cell: (item) => {
      const value = item.average_relevance;
      if (value === undefined || value === null) return "N/A";
      return parseFloat(value).toFixed(2);
    },
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
    cell: (item) => {
      const value = item.average_correctness;
      if (value === undefined || value === null) return "N/A";
      return parseFloat(value).toFixed(2);
    },
    sortingField: "average_correctness",
    sortingComparator: (a, b) => {
      const aVal = a.average_correctness === undefined || a.average_correctness === null ? 0 : parseFloat(a.average_correctness);
      const bVal = b.average_correctness === undefined || b.average_correctness === null ? 0 : parseFloat(b.average_correctness);
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
    cell: (item) => {
      const value = item.similarity;
      if (value === undefined || value === null) return "N/A";
      return parseFloat(value).toFixed(2);
    },
    sortingField: "similarity"
  },
  {
    id: "relevance",
    header: "Relevance",
    cell: (item) => {
      const value = item.relevance;
      if (value === undefined || value === null) return "N/A";
      return parseFloat(value).toFixed(2);
    },
    sortingField: "relevance"
  },
  {
    id: "correctness",
    header: "Correctness",
    cell: (item) => {
      const value = item.correctness;
      if (value === undefined || value === null) return "N/A";
      return parseFloat(value).toFixed(2);
    },
    sortingField: "correctness"
  },
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
