import { useState } from "react";
import FeedbackTab from "./feedback-tab";
import AdminPageLayout from "../../components/admin-page-layout";

export default function UserFeedbackPage() {
  const [feedback, setFeedback] = useState<any>({});

  return (
    <AdminPageLayout
      title="User Feedback"
      description="Review and manage feedback submitted by chatbot users."
      breadcrumbLabel="User Feedback"
    >
      <FeedbackTab
        updateSelectedFeedback={setFeedback}
        selectedFeedback={feedback}
      />
    </AdminPageLayout>
  );
}
