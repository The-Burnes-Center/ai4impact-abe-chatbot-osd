import { Typography } from "@mui/material";

export interface FeedbackTabProps {
  updateSelectedFeedback?: any;
  selectedFeedback?: any;
}

export default function FeedbackTab() {
  return (
    <Typography color="text.secondary">
      Feedback Ops moved to the dedicated admin workspace.
    </Typography>
  );
}
