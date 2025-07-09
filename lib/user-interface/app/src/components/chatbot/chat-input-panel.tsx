import {
  Button,
  Container,
  Icon,
  Select,
  SelectProps,
  SpaceBetween,
  Spinner,
  StatusIndicator,
} from "@cloudscape-design/components";
import {
  Dispatch,
  SetStateAction,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import { Auth } from "aws-amplify";
import TextareaAutosize from "react-textarea-autosize";
import { ReadyState } from "react-use-websocket";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import styles from "../../styles/chat.module.scss";

import {  
  ChatBotHistoryItem,  
  ChatBotMessageType,
  ChatInputState,  
} from "./types";

import {  
  assembleHistory
} from "./utils";

import { Utils } from "../../common/utils";
import {SessionRefreshContext} from "../../common/session-refresh-context"
import { useNotifications } from "../notif-manager";

export interface ChatInputPanelProps {
  running: boolean;
  setRunning: Dispatch<SetStateAction<boolean>>;
  session: { id: string; loading: boolean };
  messageHistory: ChatBotHistoryItem[];
  setMessageHistory: (history: ChatBotHistoryItem[]) => void;  
}

export abstract class ChatScrollState {
  static userHasScrolled = false;
  static skipNextScrollEvent = false;
  static skipNextHistoryUpdate = false;
}

export default function ChatInputPanel(props: ChatInputPanelProps) {
  const appContext = useContext(AppContext);
  const {needsRefresh, setNeedsRefresh} = useContext(SessionRefreshContext);  
  const { transcript, listening, browserSupportsSpeechRecognition } =
    useSpeechRecognition();
  const [state, setState] = useState<ChatInputState>({
    value: "",
    
  });
  const { notifications, addNotification } = useNotifications();
  const [readyState, setReadyState] = useState<ReadyState>(
    ReadyState.OPEN
  );  
  const messageHistoryRef = useRef<ChatBotHistoryItem[]>([]);

  const [
    selectedDataSource,
    setSelectedDataSource
  ] = useState({ label: "Bedrock Knowledge Base", value: "kb" } as SelectProps.ChangeDetail["selectedOption"]);

  useEffect(() => {
    messageHistoryRef.current = props.messageHistory;    
  }, [props.messageHistory]);
  


  /** Speech recognition */
  useEffect(() => {
    if (transcript) {
      setState((state) => ({ ...state, value: transcript }));
    }
  }, [transcript]);


  /**Some amount of auto-scrolling for convenience */
  useEffect(() => {
    const onWindowScroll = () => {
      if (ChatScrollState.skipNextScrollEvent) {
        ChatScrollState.skipNextScrollEvent = false;
        return;
      }

      const isScrollToTheEnd =
        Math.abs(
          window.innerHeight +
          window.scrollY -
          document.documentElement.scrollHeight
        ) <= 10;

      if (!isScrollToTheEnd) {
        ChatScrollState.userHasScrolled = true;
      } else {
        ChatScrollState.userHasScrolled = false;
      }
    };

    window.addEventListener("scroll", onWindowScroll);

    return () => {
      window.removeEventListener("scroll", onWindowScroll);
    };
  }, []);

  useLayoutEffect(() => {
    if (ChatScrollState.skipNextHistoryUpdate) {
      ChatScrollState.skipNextHistoryUpdate = false;
      return;
    }

    if (!ChatScrollState.userHasScrolled && props.messageHistory.length > 0) {
      ChatScrollState.skipNextScrollEvent = true;
      window.scrollTo({
        top: document.documentElement.scrollHeight + 1000,
        behavior: "instant",
      });
    }
  }, [props.messageHistory]);

  /**Sends a message to the chat API */
  const handleSendMessage = async () => {    
    if (props.running) return;
    if (readyState !== ReadyState.OPEN) return;
    ChatScrollState.userHasScrolled = false;

    let username;
    await Auth.currentAuthenticatedUser().then((value) => username = value.username);
    if (!username) return;    

    const messageToSend = state.value.trim();
    if (messageToSend.length === 0) {
      addNotification("error","Please do not submit blank text!");
      return;          
    }
    setState({ value: "" });    
    
    try {
      props.setRunning(true);
      let receivedData = '';      
      
      /**Add the user's query to the message history and a blank dummy message
       * for the chatbot as the response loads
       */
      messageHistoryRef.current = [
        ...messageHistoryRef.current,

        {
          type: ChatBotMessageType.Human,
          content: messageToSend,
          metadata: {            
          },          
        },
        {
          type: ChatBotMessageType.AI,          
          content: receivedData,
          metadata: {},
        },
      ];
      props.setMessageHistory(messageHistoryRef.current);

      let firstTime = false;
      if (messageHistoryRef.current.length < 3) {
        firstTime = true;
      }
      // old non-auth url -> const wsUrl = 'wss://ngdpdxffy0.execute-api.us-east-1.amazonaws.com/test/'; 
      // old shared url with auth -> wss://caoyb4x42c.execute-api.us-east-1.amazonaws.com/test/     
      // first deployment URL 'wss://zrkw21d01g.execute-api.us-east-1.amazonaws.com/prod/';
      const TEST_URL = appContext.wsEndpoint+"/"

      // Get a JWT token for the API to authenticate on      
      const TOKEN = await Utils.authenticate()
                
      const wsUrl = TEST_URL+'?Authorization='+TOKEN;
      const ws = new WebSocket(wsUrl);

      let incomingMetadata: boolean = false;
      let sources = {};

      /**If there is no response after a minute, time out the response to try again. */
      setTimeout(() => {if (receivedData == '') {
        ws.close()
        messageHistoryRef.current.pop();
        messageHistoryRef.current.push({
          type: ChatBotMessageType.AI,          
          content: 'Response timed out!',
          metadata: {},
        })
      }},60000)

      // Event listener for when the connection is open
      ws.addEventListener('open', function open() {
        console.log('Connected to the WebSocket server');        
        const message = JSON.stringify({
          "action": "getChatbotResponse",
          "data": {
            userMessage: messageToSend,
            chatHistory: assembleHistory(messageHistoryRef.current.slice(0, -2)),
            systemPrompt: `
            Purpose: This agent is designed to assist users in navigating the procurement process by referencing two key documents: SWCIndex and the OSD procurement handbook. The goal is to guide buyers and executive office staff through compliance procedures while providing clear, step-by-step instructions for efficient decision-making.
            Core Capabilities:
            - **Document Integration:**
              1. **SWCIndex**: Check for available Statewide Contracts relevant to the user’s procurement needs. Only need to check sheet 'Alphabetical by Index Listing'.
              2. **OSD Procurement Handbook**: Offer guidance and compliance information, referencing specific sections for verification.

            - **User Interaction:**
              Engage with users to gather essential procurement details and provide professional, actionable guidance tailored to their specific situation.

**Steps for the Agent to Follow in case user wants to buy goods/services:**

1. **Initial Inquiry: Gather Information**
   - Ask: "Which department are you purchasing for?"
   - Ask: "Is this procurement for a small or large purchase?"
   Use this information to tailor guidance to the user’s specific requirements.

2. **Contract Identification: Check Existing Contracts**
   - Search the SWCIndex to determine if a relevant Statewide Contract exists for the requested goods or services.
   - If a contract exists: Provide the contract number, vendor details, and next steps.
   - If no contract is found: Guide the user on the appropriate procurement process, such as issuing an RFR or making an incidental purchase.

3. **Provide Contract Details**
   - Share the contract number and vendor details.
   - Guide users to the Contract User Guide in COMMBUYS for instructions on how to proceed.

4. **Guide on Using Contracts**
   - Instruct users to follow contract-specific procedures by reviewing the Contract User Guide.
   - Provide step-by-step guidance on actions such as soliciting quotes, creating purchase orders, and obtaining necessary approvals.

5. **Handling Non-Contracted Items**
   - Guide users through the competitive procurement process, including issuing an RFR or making an incidental purchase, depending on the procurement’s value.
   - Ensure all actions comply with the OSD procurement handbook.

6. **Emphasize Record-Keeping**
   - Remind users to maintain documentation (quotes, purchase orders, vendor communications) according to the OSD procurement handbook.
   - Reference specific handbook sections for compliance verification.

7. **Regular Use and Updates**
   - Provide ongoing assistance for day-to-day procurement activities and update users on any changes to processes or contracts.

8. **Redirect to Authorities When Needed**
   - If a process is unclear, redirect users to the appropriate procurement authority, providing contact information and guidance on how to reach them.

**Deployment Notes:**
- **Model Training:** Train the agent using the language and procedures outlined in the OSD procurement handbook and SWCIndex.
- **User Interface:** Design the UI to capture procurement details and dynamically reference the correct sections of the handbook and relevant contracts.

**Example Interaction when user wants to purchase goods/services:**
- **User:** "I need to purchase uniforms for my department."
- **Agent:** "Which department are you purchasing for?"
- **User:** "The Health Department."
- **Agent:** "Is this a small or large procurement?"
- **User:** "Large procurement."
- **Agent:** "Let me check for available Statewide Contracts. Yes, Contract Number SWC-12345 is available for uniforms. Access it on COMMBUYS, and review the User Guide for the next steps."

**Example Interaction when user wants guidance:**
- **User:** "Which platform should I use to place bids?"
- **Agent:** "You can use COMMBUYS for the purpose of placing bids. Although you may want to reference specific contract user guides to cross verify in case of any exception."
`,
            projectId: 'rsrs111111',
            user_id: username,
            session_id: props.session.id,
            retrievalSource: selectedDataSource.value
          }
        });
        
        ws.send(message);
        
      });
      // Event listener for incoming messages
      ws.addEventListener('message', async function incoming(data) {
        // First, try to parse as JSON and check for the specific timeout error
        try {
          const parsed = JSON.parse(data.data);
          if (parsed.message === "Endpoint request timed out" && 
              parsed.connectionId && 
              parsed.requestId) {
            // This is the harmless API Gateway timeout error - ignore it completely
            console.log("Filtered out API Gateway timeout error");
            return;
          }
        } catch (e) {
          // Not JSON or different structure, continue with normal processing
        }

        /**This is a custom tag from the API that denotes that an error occured
         * and the next chunk will be an error message. */              
        if (data.data.includes("<!ERROR!>:")) {
          addNotification("error",data.data);
          console.error("WebSocket error received:", data.data);
          ws.close();
          return;
        }
        /**This is a custom tag from the API that denotes when the model response
         * ends and when the sources are coming in
         */
        if (data.data == '!<|EOF_STREAM|>!') {          
          incomingMetadata = true;
          return;          
        }
        if (!incomingMetadata) {
          receivedData += data.data;
        } else {
          let sourceData = JSON.parse(data.data);
          sourceData = sourceData.map((item) => {
            if (item.title == "") {
              return {title: item.uri.slice((item.uri as string).lastIndexOf("/") + 1), uri: item.uri}
            } else {
              return item
            }
          })
          sources = { "Sources": sourceData}
          console.log(sources);
        }

        // Update the chat history state with the new message        
        messageHistoryRef.current = [
          ...messageHistoryRef.current.slice(0, -2),

          {
            type: ChatBotMessageType.Human,
            content: messageToSend,
            metadata: {
              
            },            
          },
          {
            type: ChatBotMessageType.AI,            
            content: receivedData,
            metadata: sources,
          },
        ];        
        props.setMessageHistory(messageHistoryRef.current);        
      });
      // Handle possible errors
      ws.addEventListener('error', function error(err) {
        console.error('WebSocket error:', err);
      });
      // Handle WebSocket closure
      ws.addEventListener('close', async function close() {
        // if this is a new session, the backend will update the session list, so
        // we need to refresh        
        if (firstTime) {             
          Utils.delay(1500).then(() => setNeedsRefresh(true));
        }
        props.setRunning(false);        
        console.log('Disconnected from the WebSocket server');
      });

    } catch (error) {      
      console.error('Error sending message:', error);
      alert('Sorry, something has gone horribly wrong! Please try again or refresh the page.');
      props.setRunning(false);
    }     
  };

  const connectionStatus = {
    [ReadyState.CONNECTING]: "Connecting",
    [ReadyState.OPEN]: "Open",
    [ReadyState.CLOSING]: "Closing",
    [ReadyState.CLOSED]: "Closed",
    [ReadyState.UNINSTANTIATED]: "Uninstantiated",
  }[readyState];

  return (
    <SpaceBetween direction="vertical" size="l">
      <Container>
        <div className={styles.input_textarea_container}>
          <SpaceBetween size="xxs" direction="horizontal" alignItems="center">
            {browserSupportsSpeechRecognition ? (
              <Button
                iconName={listening ? "microphone-off" : "microphone"}
                variant="icon"
                ariaLabel="microphone-access"
                onClick={() =>
                  listening
                    ? SpeechRecognition.stopListening()
                    : SpeechRecognition.startListening()
                }
              />
            ) : (
              <Icon name="microphone-off" variant="disabled" />
            )}
          </SpaceBetween>          
          <TextareaAutosize
            className={styles.input_textarea}
            maxRows={6}
            minRows={1}
            spellCheck={true}
            autoFocus
            onChange={(e) =>
              setState((state) => ({ ...state, value: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key == "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            value={state.value}
            placeholder={"Message ABE"}
          />
          <div style={{ marginLeft: "8px" }}>            
            <Button
              disabled={
                readyState !== ReadyState.OPEN ||                
                props.running ||
                state.value.trim().length === 0 ||
                props.session.loading
              }
              onClick={handleSendMessage}
              iconAlign="right"
              iconName={!props.running ? "angle-right-double" : undefined}
              variant="primary"
            >
              {props.running ? (
                <>
                  Loading&nbsp;&nbsp;
                  <Spinner />
                </>
              ) : (
                "Send"
              )}
            </Button>
          </div>
        </div>
      </Container>
      <div className={styles.input_controls}>      
        <div>
        </div>  
        <div className={styles.input_controls_right}>
          <SpaceBetween direction="horizontal" size="xxs" alignItems="center">
            <div style={{ paddingTop: "1px" }}>              
            </div>            
          </SpaceBetween>
        </div>
      </div>
    </SpaceBetween>
  );
}
