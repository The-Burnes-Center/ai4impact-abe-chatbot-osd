import Chat from "../../../components/chatbot/chat";
import { useParams } from "react-router-dom";
import { useDocumentTitle } from "../../../common/hooks/use-document-title";

export default function Playground() {
  useDocumentTitle("Chat");
  const { sessionId } = useParams();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: 0, overflow: "hidden" }}>
      <Chat sessionId={sessionId} />
    </div>
  );
}
