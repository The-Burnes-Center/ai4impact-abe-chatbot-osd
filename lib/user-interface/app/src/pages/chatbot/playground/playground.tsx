import Chat from "../../../components/chatbot/chat";
import { useParams } from "react-router-dom";

export default function Playground() {
  const { sessionId } = useParams();

  return (
    <div>
      <Chat sessionId={sessionId} />
    </div>
  );
}
