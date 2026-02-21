import Chat from "../../../components/chatbot/chat";
import { useParams } from "react-router-dom";

export default function Playground() {
  const { sessionId } = useParams();

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: 0, overflow: "hidden" }}>
      <Chat sessionId={sessionId} />
    </div>
  );
}
