import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Typography,
  Stack,
  Breadcrumbs,
  Link,
} from "@mui/material";
import { CHATBOT_NAME } from "../../common/constants";
import FeedbackDetailsTab from "./feedback-details-tab";
import { useDocumentTitle } from "../../common/hooks/use-document-title";

const UserFeedbackDetailPage = () => {
  useDocumentTitle("Feedback Details");
  const location = useLocation();
  const navigate = useNavigate();
  const feedbackItem = location.state?.feedback;

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link
          component="button"
          underline="hover"
          onClick={() => navigate("/")}
        >
          {CHATBOT_NAME}
        </Link>
        <Link
          component="button"
          underline="hover"
          onClick={() => navigate("/admin/user-feedback")}
        >
          View Feedback
        </Link>
        <Typography color="text.primary">Feedback Details</Typography>
      </Breadcrumbs>

      <Typography variant="h4">Feedback Details</Typography>

      <FeedbackDetailsTab selectedFeedback={feedbackItem} />
    </Stack>
  );
};

export default UserFeedbackDetailPage;
