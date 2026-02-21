import React from "react";
import { Paper, Typography, Divider, Box } from "@mui/material";

const FeedbackDetailsTab = ({ selectedFeedback }) => {
  return (
    <Paper sx={{ p: 3 }}>
      <Typography variant="h6" fontWeight={700}>
        {`Feedback ID: ${selectedFeedback.FeedbackID}`}
      </Typography>
      <Divider sx={{ my: 2 }} />
      <Box>
        <Typography component="span" fontWeight={600} sx={{ mr: 1 }}>
          Submission Time:
        </Typography>
        <Typography component="span">
          {new Date(selectedFeedback.CreatedAt).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "numeric",
            hour12: true,
          })}
        </Typography>
        <br />

        <Divider sx={{ my: 2 }} light />

        <Typography component="span" fontWeight={600} sx={{ mr: 1 }}>
          Problem:
        </Typography>
        <Typography component="span">
          {selectedFeedback.Problem &&
          selectedFeedback.Problem.trim() !== ""
            ? selectedFeedback.Problem
            : "N/A (Good Response)"}
        </Typography>
        <br />

        <Divider sx={{ my: 2 }} light />

        <Typography component="span" fontWeight={600} sx={{ mr: 1 }}>
          User Prompt:
        </Typography>
        <Typography component="span">
          {selectedFeedback.UserPrompt}
        </Typography>
        <br />

        <Divider sx={{ my: 2 }} light />

        <Typography component="span" fontWeight={600} sx={{ mr: 1 }}>
          Chatbot Response:
        </Typography>
        <Typography component="span">
          {selectedFeedback.ChatbotMessage}
        </Typography>
        <br />

        <Divider sx={{ my: 2 }} light />

        <Typography component="span" fontWeight={600} sx={{ mr: 1 }}>
          User Feedback Comments:
        </Typography>
        <Typography component="span">
          {selectedFeedback.FeedbackComments &&
          selectedFeedback.FeedbackComments.trim() !== ""
            ? selectedFeedback.FeedbackComments
            : "N/A"}
        </Typography>
        <br />

        <Divider sx={{ my: 2 }} light />

        <Typography component="span" fontWeight={600} sx={{ mr: 1 }}>
          Response Sources:
        </Typography>
        <Typography component="span">
          {typeof selectedFeedback.Sources === "string"
            ? JSON.parse(selectedFeedback.Sources)
                .map((source) => source.title)
                .join(", ")
            : Array.isArray(selectedFeedback.Sources) &&
              selectedFeedback.Sources.length > 0
            ? selectedFeedback.Sources.map((source) => source.title).join(", ")
            : "No sources available"}
        </Typography>
      </Box>
    </Paper>
  );
};

export default FeedbackDetailsTab;
