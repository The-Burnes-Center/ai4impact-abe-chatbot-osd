/**
 * @module websocket-chat/index
 *
 * WebSocket chat handler for the ABE (Assistive Buyers Engine) chatbot.
 *
 * This is the main entry point for all chat interactions. It receives messages
 * over API Gateway WebSocket, runs an agentic tool-use loop against Bedrock
 * (Claude), and streams the response back to the client chunk-by-chunk.
 *
 * ## Agentic Loop Overview
 *
 * The handler implements a state machine that iterates until the model produces
 * a final text response (stop_reason !== "tool_use") or a safety limit is hit:
 *
 *   1. Send conversation history + tools to Bedrock and open a streaming response.
 *   2. Accumulate streamed text deltas and tool_use input deltas.
 *   3. On stop_reason "tool_use": execute all pending tool calls, append results
 *      to history, and loop back to step 1.
 *   4. On stop_reason "end_turn" / "max_tokens": finalize citations, stream
 *      the answer to the client, and exit the loop.
 *
 * ## Safety Rails
 *
 * - MAX_TOOL_ROUNDS caps total tool invocations per request.
 * - COMPRESSION_THRESHOLD triggers automatic history summarization.
 * - MAX_ESTIMATED_TOKENS triggers aggressive trimming of large tool results.
 * - MAX_STREAM_RETRIES retries transient Bedrock errors (throttles, timeouts).
 * - connectionGone flag short-circuits WebSocket sends after client disconnect.
 *
 * ## Message Protocol (WebSocket Data field)
 *
 * - Plain text: streamed answer chunks (client appends to UI)
 * - "!<|STATUS|>!...": transient status indicator (e.g., "Searching documents...")
 * - "<!ERROR!>: ...": terminal error shown to user
 * - "!<|EOF_STREAM|>!": signals end of answer; next frame is JSON metadata
 *   shaped as `{ Sources, Trace, ContextUsage }`. ContextUsage carries
 *   `{ estimatedTokens, maxTokens, percent, compactionRounds }` so the client
 *   can render a live memory-usage indicator.
 *
 * ## Context management
 *
 * When estimated tokens exceed COMPRESSION_THRESHOLD the loop runs up to
 * MAX_COMPACTION_ROUNDS recursive summarization passes (tier 1 -> 2 -> 3),
 * pinning the user's original question at the top so the conversation topic
 * survives every compaction. If even after all rounds the request still
 * exceeds MAX_ESTIMATED_TOKENS, the assistant emits a friendly inline note
 * asking the user to start a fresh chat -- never an out-of-band error frame.
 */

import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import ClaudeModel from "./models/chat-model.mjs";
import { randomUUID } from "crypto";

import { insertCitationMarkers, validateSelfManagedCitations, renumberCitations } from './citations.mjs';
import { retrieveKBDocs, retrieveFullDocument } from './kb.mjs';
import { STATIC_TOOLS, truncate, capToolResultSize, getAllTools, fetchMetadata, enrichExcelIndexResult, invokeIndexQuery, constructSysPrompt } from './tools.mjs';
import { logger, setCorrelationId } from './logger.mjs';



/*global fetch*/

const ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;
const wsConnectionClient = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const lambdaClient = new LambdaClient({});

/**
 * Hard ceiling for estimated token count before the request is aborted.
 * Set to 160K to stay safely within Claude's 200K context window after
 * accounting for output tokens (16K max) and estimation inaccuracy (~15%).
 */
const MAX_ESTIMATED_TOKENS = 160000;

/**
 * Soft threshold (~75% of MAX_ESTIMATED_TOKENS) that triggers automatic
 * context compression via the summarizer Lambda. Compressing at 120K rather
 * than at the hard limit gives headroom to absorb the summary + remaining
 * messages without immediately hitting MAX_ESTIMATED_TOKENS.
 */
const COMPRESSION_THRESHOLD = 120000;

/**
 * Rough token estimate using character count / 3.5. This is intentionally
 * conservative (over-estimates) since triggering compression too early is
 * cheaper than hitting the hard context limit and aborting.
 *
 * @param {string} systemPrompt - The assembled system prompt text.
 * @param {Array} history - Conversation message history (Bedrock format).
 * @param {Array} tools - Tool definition array sent to the model.
 * @returns {number} Estimated token count.
 */
function estimateTokens(systemPrompt, history, tools) {
  const chars = systemPrompt.length + JSON.stringify(history).length + JSON.stringify(tools).length;
  return Math.ceil(chars / 3.5);
}

/**
 * Compress older conversation history by summarizing it via the context-summarizer Lambda.
 *
 * Implements the industry-standard "two-tier sliding window with summarization"
 * pattern (LangChain ConversationSummaryBufferMemory; Claude Code auto-compact):
 *
 *   - "toSummarize": all messages except the last `keepLastN` -- fed to the summarizer.
 *   - "toKeep": the most recent `keepLastN` messages preserved verbatim so the
 *     model retains immediate conversational context.
 *   - "userGoal" (optional): the original user question, pinned at the very top
 *     of the returned history so it survives every compaction round and the
 *     model never loses the topic of the conversation.
 *
 * The summary is injected as a synthetic [CONVERSATION SUMMARY] user message
 * after the optional pinned goal, giving the model condensed context from
 * earlier turns without consuming proportional token budget.
 *
 * @param {Array<{role: string, content: *}>} history - Full conversation history in Bedrock format.
 * @param {string} connectionId - WebSocket connection ID (used to send a "Thinking..." status).
 * @param {Object} [opts]
 * @param {number} [opts.keepLastN=4] - How many of the most recent messages to keep verbatim.
 * @param {string} [opts.userGoal] - The original user question to pin at the top of history.
 * @returns {Promise<{compressedHistory: Array, summaryText: string} | null>}
 *   The compressed history and raw summary text, or null if there are fewer
 *   than 2 messages eligible for summarization (nothing worth compressing).
 */
async function summarizeHistory(history, connectionId, opts = {}) {
  const keepLastN = Math.max(2, opts.keepLastN ?? 4);
  const userGoal = typeof opts.userGoal === "string" ? opts.userGoal.trim() : "";

  // Send a neutral status so the user sees the thinking indicator
  try {
    await wsConnectionClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: "!<|STATUS|>!Summarizing earlier messages so we can keep going\u2026"
    }));
  } catch (statusErr) {
    logger.warn("Status send failed", { error: statusErr?.message });
  }

  const toSummarize = history.slice(0, -keepLastN);
  const toKeep = history.slice(-keepLastN);

  if (toSummarize.length < 2) {
    return null;
  }

  // Build text representation of older messages for the summarizer
  const conversationText = toSummarize.map(msg => {
    const text = Array.isArray(msg.content)
      ? msg.content.map(b => b.text || b.source?.data || "").join(" ")
      : String(msg.content);
    return `${msg.role}: ${text}`;
  }).join("\n\n");

  const payload = JSON.stringify({ conversation_text: conversationText });
  const command = new InvokeCommand({
    FunctionName: process.env.CONTEXT_SUMMARIZER_FUNCTION,
    Payload: Buffer.from(payload),
  });
  const response = await lambdaClient.send(command);
  const result = JSON.parse(Buffer.from(response.Payload).toString());

  if (result.statusCode !== 200) {
    throw new Error(`Context summarizer returned ${result.statusCode}: ${result.body}`);
  }

  const body = JSON.parse(result.body);
  const summaryText = body.summary_text;

  // Pin the user's original goal at the top so the model never loses topic
  // through repeated compactions ("lost-in-the-middle" mitigation).
  const compressedHistory = [];
  if (userGoal) {
    compressedHistory.push(
      { role: "user", content: [{ type: "text", text: `[USER GOAL]\nThe user's original question for this session was:\n"""\n${userGoal}\n"""\nKeep this in mind as the anchoring topic across the conversation.` }] },
      { role: "assistant", content: [{ type: "text", text: "Acknowledged. I'll keep the original question in mind throughout this conversation." }] }
    );
  }
  compressedHistory.push(
    { role: "user", content: [{ type: "text", text: `[CONVERSATION SUMMARY]\n${summaryText}` }] },
    { role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our earlier conversation and will continue naturally." }] },
    ...toKeep
  );

  return { compressedHistory, summaryText };
}

/**
 * Persist a response trace row to the ResponseTrace DynamoDB table.
 *
 * Each chat turn produces one trace record capturing the user prompt, final
 * answer, retrieved sources, and model/prompt metadata. This powers the admin
 * evaluation pipeline and audit trail. Silently no-ops if the table env var
 * is not configured (e.g., in local testing).
 *
 * @param {Object} params
 * @param {string} params.messageId - Unique ID for this message (UUID).
 * @param {string} params.sessionId - Chat session ID.
 * @param {number} params.turnIndex - 1-based turn number within the session.
 * @param {string} params.userPrompt - The user's original message text.
 * @param {string} params.finalAnswer - The model's final streamed answer.
 * @param {Array} params.sources - Array of source objects (KB docs + Excel).
 * @param {string} params.promptVersionId - Prompt version from the prompt registry.
 * @param {string} params.promptTemplateHash - Hash of the prompt template used.
 * @param {string} params.modelId - Bedrock model ID used for this turn.
 * @param {string} params.guardrailId - Bedrock Guardrail ID (empty if disabled).
 */
/**
 * System prompt for the handoff-brief LLM call. Kept in module scope so it is
 * stable across invocations and easy to tweak without hunting through the
 * agentic loop.
 */
const HANDOFF_SUMMARY_SYSTEM_PROMPT = `You write concise handoff briefs that let a user resume a conversation in a fresh chat session.

Output ONLY the brief in this exact markdown shape (no preamble, no apology, no closing remarks):

**Original goal:** <one sentence describing what the user is trying to accomplish>
**Progress so far:**
- <short bullet covering what has been established or retrieved>
- <short bullet>
**Open questions / next steps:**
- <short bullet describing what to do next>
- <short bullet>
**Key context to preserve:**
- <short bullet listing specific contracts, vendors, filters, or decisions the new session needs>
- <short bullet>

Rules:
- Keep the entire brief under 250 words.
- Be specific: include contract IDs (e.g. "VEH123"), vendor names, dollar amounts, dates, and filters that were used.
- Do NOT invent details. If something is unknown, omit the bullet.
- Do NOT mention that the previous session ran out of memory.`;

/**
 * Generate a markdown handoff brief the user can paste into a fresh chat
 * to continue where this session left off. Used when the conversation
 * context exceeds the model's window (post-compaction overflow OR Bedrock
 * ValidationException). Returns null on any failure so the caller can fall
 * back to the legacy plain-text notice without breaking the chat flow.
 *
 * Note: we deliberately call the FAST model with a small, bounded set of
 * inputs (pinned goal + running summary + the most recent chat-history
 * exchanges) instead of the full agentic-loop history, because the latter
 * is what blew the context window in the first place.
 *
 * @param {Object} params
 * @param {string} params.userGoal - The pinned original user question.
 * @param {string} params.currentMessage - The latest user message.
 * @param {string|null} params.contextSummary - Latest compaction summary, if any.
 * @param {Array<{user:string, chatbot:string}>} params.lastMessages - Up to 12 prior chat entries.
 * @param {string} [params.latestAssistantText] - Most recent partial assistant text, if any.
 * @returns {Promise<string|null>} Markdown brief, or null on failure.
 */
async function generateHandoffSummary({ userGoal, currentMessage, contextSummary, lastMessages, latestAssistantText }) {
  try {
    const fastModelId = process.env.FAST_MODEL_ID || process.env.PRIMARY_MODEL_ID;
    const fastModel = new ClaudeModel(fastModelId);

    // Build a compact transcript of the most recent exchanges. Cap each turn
    // so an unusually long single answer can't push us back over the limit.
    const TURN_CHAR_CAP = 1500;
    const recentTurns = Array.isArray(lastMessages)
      ? lastMessages.slice(-6).map((entry, i) => {
          const u = String(entry?.user ?? "").slice(0, TURN_CHAR_CAP);
          const a = String(entry?.chatbot ?? "").slice(0, TURN_CHAR_CAP);
          return `Turn ${i + 1}\nUser: ${u}\nAssistant: ${a}`;
        }).join("\n\n")
      : "";

    const inputSections = [
      `ORIGINAL USER QUESTION (pinned):\n${userGoal}`,
      currentMessage && currentMessage !== userGoal ? `LATEST USER MESSAGE:\n${currentMessage}` : null,
      contextSummary ? `RUNNING CONVERSATION SUMMARY (already compressed):\n${contextSummary}` : null,
      recentTurns ? `RECENT EXCHANGES (most recent last):\n${recentTurns}` : null,
      latestAssistantText ? `MOST RECENT (PARTIAL) ASSISTANT REPLY:\n${String(latestAssistantText).slice(0, 3000)}` : null,
    ].filter(Boolean).join("\n\n---\n\n");

    const brief = await fastModel.getResponse(
      HANDOFF_SUMMARY_SYSTEM_PROMPT,
      [],
      inputSections,
      { maxTokens: 600 }
    );
    const trimmed = (brief || "").trim();
    // The chat-model fallback returns an apology string on failure -- treat
    // that the same as a hard failure so we don't paste an apology into the
    // handoff message.
    if (!trimmed || /^I'm sorry/i.test(trimmed)) return null;
    return trimmed;
  } catch (err) {
    logger.error("Handoff summary generation failed", { error: err?.message });
    return null;
  }
}

/**
 * Compose the user-facing message that follows a context-overflow event.
 * Wraps the LLM-generated handoff brief with copy/paste instructions, or
 * falls back to a plain notice when the brief could not be generated.
 *
 * @param {string|null} handoffBrief - Markdown brief from generateHandoffSummary.
 * @returns {string} Markdown chat message ready to send via WebSocket.
 */
function formatContextOverflowMessage(handoffBrief) {
  if (!handoffBrief) {
    return "I've compacted this conversation as much as I can while preserving the important parts, but it's still too large for me to continue here. To keep going on a related question, please click \"+ New chat\" in the sidebar to start a fresh conversation.";
  }
  return [
    "I've reached the memory limit for this conversation, so I can't continue here.",
    "",
    "To pick up where we left off, click **+ New chat** in the sidebar and paste the handoff brief below as your first message:",
    "",
    "---",
    "",
    handoffBrief,
    "",
    "---",
  ].join("\n");
}

async function writeResponseTrace({
  messageId,
  sessionId,
  turnIndex,
  userPrompt,
  finalAnswer,
  sources,
  promptVersionId,
  promptTemplateHash,
  modelId,
  guardrailId,
  userId,
}) {
  const tableName = process.env.RESPONSE_TRACE_TABLE;
  if (!tableName) {
    return;
  }

  const createdAt = new Date().toISOString();
  const item = {
    MessageId: { S: messageId },
    SessionId: { S: sessionId },
    CreatedAt: { S: createdAt },
    TurnIndex: { N: String(turnIndex) },
    UserPrompt: { S: userPrompt },
    FinalAnswer: { S: finalAnswer || "" },
    Sources: { S: JSON.stringify(sources || []) },
    RetrievalSnapshot: { S: JSON.stringify({ sources: sources || [] }) },
    PromptVersionId: { S: promptVersionId || "embedded-default" },
    PromptTemplateHash: { S: promptTemplateHash || "" },
    ModelId: { S: modelId || process.env.PRIMARY_MODEL_ID || "" },
    GuardrailId: { S: guardrailId || "" },
    TraceSummary: { S: JSON.stringify({
      sourceCount: Array.isArray(sources) ? sources.length : 0,
    }) },
  };
  // UserId lets the feedback handler verify ownership when a user submits
  // feedback against this message — without it any authenticated user can
  // POST /feedback with someone else's messageId and read the question/answer.
  if (userId) {
    item.UserId = { S: String(userId) };
  }
  await ddbClient.send(new PutItemCommand({
    TableName: tableName,
    Item: item,
  }));
}

/**
 * Key prefix for clean-disconnect markers stored in the response-trace table
 * (reusing it avoids a new table; the prefix keeps markers out of trace
 * queries, which look up real message UUIDs).
 */
const DISCONNECT_MARKER_PREFIX = "WSDISCONNECT#";

/**
 * Marker lifetime. It only needs to outlive the longest possible chat
 * invocation (Lambda caps at 15 minutes); the table's TTL deletes it after.
 */
const DISCONNECT_MARKER_TTL_SECONDS = 30 * 60;

/**
 * Record that API Gateway delivered a clean $disconnect for this connection.
 *
 * A deliberate client stop (stop button, tab close, refresh) closes the
 * socket properly, so $disconnect fires within moments. A network-path
 * failure (VPN/proxy/NAT silently severing the connection) instead leaves a
 * half-open socket: sends start returning 410 GoneException but no
 * $disconnect arrives until much later, if ever. The streaming loop reads
 * this marker to tell the two apart and decide whether to discard or finish
 * and save the in-flight answer.
 */
async function writeDisconnectMarker(connectionId) {
  const tableName = process.env.RESPONSE_TRACE_TABLE;
  if (!tableName || !connectionId) return;
  try {
    await ddbClient.send(new PutItemCommand({
      TableName: tableName,
      Item: {
        MessageId: { S: DISCONNECT_MARKER_PREFIX + connectionId },
        DisconnectedAt: { S: new Date().toISOString() },
        expiresAt: { N: String(Math.floor(Date.now() / 1000) + DISCONNECT_MARKER_TTL_SECONDS) },
      },
    }));
  } catch (err) {
    logger.warn("Failed to write disconnect marker", { error: err?.message });
  }
}

/** True when a clean $disconnect marker exists for this connection. */
async function hasDisconnectMarker(connectionId) {
  const tableName = process.env.RESPONSE_TRACE_TABLE;
  if (!tableName || !connectionId) return false;
  try {
    const resp = await ddbClient.send(new GetItemCommand({
      TableName: tableName,
      Key: { MessageId: { S: DISCONNECT_MARKER_PREFIX + connectionId } },
      ConsistentRead: true,
    }));
    return !!resp.Item;
  } catch (err) {
    // Can't tell; classify as a network drop so the answer is saved rather
    // than destroyed. Worst case a deliberately stopped answer reappears on
    // reload -- benign next to losing one the user wanted.
    logger.warn("Failed to read disconnect marker", { error: err?.message });
    return false;
  }
}

/**
 * Maximum allowed length for an incoming user message (characters).
 * 10K chars is roughly 2.5K tokens -- generous for natural-language questions
 * but prevents abuse (e.g., pasting entire documents into the chat input).
 */
const MAX_MESSAGE_LENGTH = 10_000;

/**
 * Core chat handler: validates the incoming request, runs the agentic
 * tool-use loop against Bedrock, streams the response over WebSocket,
 * and persists the conversation turn.
 *
 * ## High-level flow
 *
 * 1. **Validate** -- check for required fields, message length, etc.
 * 2. **Assemble history** -- load chat history, prepend any persisted
 *    context summary from a prior compression.
 * 3. **Agentic loop** (while !stopLoop):
 *    a. Estimate token usage; compress or trim if needed.
 *    b. Stream a Bedrock response.
 *    c. If the model requests tools (stop_reason "tool_use"):
 *       - Execute each tool call (KB search, full-doc retrieval, Excel query, metadata).
 *       - Append assistant tool_use blocks + user tool_result blocks to history.
 *       - Continue the loop (go back to step a).
 *    d. If the model emits a final answer (stop_reason "end_turn" / "max_tokens"):
 *       - Process citations, stream the answer to the client, exit loop.
 *    e. On transient errors: retry up to MAX_STREAM_RETRIES times.
 * 4. **Post-loop** -- write response trace, send EOF + metadata, save session,
 *    generate title (first turn only), persist context summary if compressed,
 *    fire-and-forget FAQ classification.
 *
 * @param {string} id - WebSocket connection ID from API Gateway.
 * @param {Object} requestJSON - Parsed WebSocket message body.
 * @param {Object} requestJSON.data - Payload containing userMessage, user_id,
 *   session_id, chatHistory, display_name, agency.
 * @returns {Promise<void>} Resolves when the full response has been streamed
 *   and the session has been saved. Errors are caught internally and sent
 *   to the client as <!ERROR!> frames.
 */
const getUserResponse = async (id, requestJSON, authorizedUserId) => {
  try {
    const data = requestJSON?.data;

    if (!data || typeof data !== 'object') {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: "<!ERROR!>: Invalid request format."
      }));
      return;
    }

    let userMessage = data.userMessage;
    // Trust only the JWT-verified principal from the WS authorizer ($connect).
    // Ignoring data.user_id prevents IDOR — a client cannot impersonate another
    // user by changing the body field.
    const userId = authorizedUserId;
    const sessionId = data.session_id;
    setCorrelationId(sessionId ?? "");

    if (typeof userMessage !== 'string' || !userMessage.trim()) {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: "<!ERROR!>: Message must be a non-empty string."
      }));
      return;
    }
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: `<!ERROR!>: Message exceeds the ${MAX_MESSAGE_LENGTH.toLocaleString()}-character limit.`
      }));
      return;
    }
    if (!userId) {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: "<!ERROR!>: Unauthorized."
      }));
      return;
    }
    if (!sessionId) {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: "<!ERROR!>: Missing session_id."
      }));
      return;
    }

    const displayName = data.display_name || "";
    const agency = data.agency || "";
    const chatHistory = data.chatHistory;
    const isFirstTurn = !Array.isArray(chatHistory) || chatHistory.length === 0;

    const knowledgeBase = new BedrockAgentRuntimeClient({ region: 'us-east-1' });

    if (!process.env.KB_ID) {
      throw new Error("Knowledge Base ID is not found.");
    }

    // Keep last 12 exchange pairs. Context compression kicks in as a safety net
    // if the assembled history exceeds COMPRESSION_THRESHOLD (~120K tokens).
    let claude = new ClaudeModel();
    let lastMessages = chatHistory.slice(-12);
    const promptConfig = await constructSysPrompt();
    const SYS_PROMPT = promptConfig.promptText;

    let stopLoop = false;
    let modelResponse = ''

    /**
     * connectionGone is a one-way latch: once set to true it stays true for
     * the remainder of this request. It is flipped when any WebSocket send
     * receives a 410 GoneException, meaning the client has disconnected
     * (e.g., closed the browser tab). All subsequent sends are skipped to
     * avoid flooding CloudWatch with expected errors.
     */
    let connectionGone = false;

    /**
     * Set alongside connectionGone after classifying WHY the connection went
     * away. true = deliberate client stop (clean $disconnect arrived: stop
     * button, tab close, refresh) -- abort generation and persist nothing.
     * false = the network path died without a clean close (VPN/proxy/NAT
     * drop): the user still wants the answer, so generation continues with
     * sends suppressed and the completed exchange is saved to history, where
     * a reload will find it.
     */
    let clientStopped = false;

    /**
     * Aborts the in-flight Bedrock streaming call when the client deliberately
     * stops (stop button / tab close), so we stop generating — and paying for —
     * tokens the user will never see. Wired into safeSend's GoneException path.
     */
    const streamAbortController = new AbortController();

    /**
     * Distinguish a deliberate stop from a dead network path after a 410.
     *
     * A clean client close produces a $disconnect within milliseconds, whose
     * handler writes a marker keyed by connection id -- but that runs as a
     * separate Lambda invocation (possibly cold-starting), so poll briefly
     * before concluding nothing is coming. Poll interval is env-overridable
     * so unit tests don't sleep.
     */
    const classifyDisconnect = async () => {
      const fromEnv = parseInt(process.env.STOP_MARKER_POLL_MS ?? "", 10);
      const pollMs = Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 2000;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
        if (await hasDisconnectMarker(id)) return true;
      }
      return false;
    };

    /**
     * safeSend wraps every WebSocket PostToConnection call. It:
     *   1. Short-circuits immediately if connectionGone is true (no-op).
     *   2. Catches GoneException (HTTP 410), flips connectionGone, and
     *      classifies the disconnect as deliberate stop vs. network drop.
     *   3. Re-throws any other error so callers can handle real failures.
     *
     * This pattern lets the agentic loop continue running to completion
     * (tool calls, session save, trace write) even after the client leaves,
     * while silently dropping the WebSocket sends that would otherwise fail.
     */
    const safeSend = async (params) => {
      if (connectionGone) return;
      try {
        await wsConnectionClient.send(new PostToConnectionCommand(params));
      } catch (err) {
        if (err.name === 'GoneException' || err.$metadata?.httpStatusCode === 410) {
          if (!connectionGone) {
            logger.warn("Client disconnected (GoneException), suppressing further send attempts");
            connectionGone = true;
            clientStopped = await classifyDisconnect();
            if (clientStopped) {
              // Deliberate stop: cancel the in-flight Bedrock stream so we
              // stop generating (and paying for) tokens nobody wants.
              streamAbortController.abort();
            } else {
              logger.warn("No clean $disconnect for this connection; treating as a network drop and finishing the answer for session history");
            }
          }
          return;
        }
        throw err;
      }
    };

    /** Running total of tool invocations across all loop iterations. */
    let toolRoundCount = 0;

    /**
     * Soft safety cap on total tool calls per request. 200 is intentionally
     * generous: with modern models we'd rather let the agent keep digging on
     * complex multi-document questions than show the user a confusing
     * "iteration limit" message after only a handful of calls. The hard
     * ceiling in practice is the Lambda's 5-minute timeout.
     *
     * If we ever do hit this number we exit the loop silently and let
     * whatever the model has already streamed stand as the answer -- no
     * out-of-band message is sent to the user.
     *
     * Override via the MAX_TOOL_ROUNDS env var (used by unit tests so they
     * don't have to drive 200 iterations through the mocked stream).
     */
    const MAX_TOOL_ROUNDS = (() => {
      const fromEnv = parseInt(process.env.MAX_TOOL_ROUNDS ?? "", 10);
      return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 200;
    })();

    /**
     * Number of compaction rounds applied so far this request. Drives the
     * tier-2/tier-3 escalation in the agentic loop and also surfaces in the
     * trailing ContextUsage metadata so the UI can show the indicator.
     */
    let compactionRounds = 0;
    /**
     * Hard cap on compaction rounds. Each round summarizes more aggressively;
     * by round 3 only the pinned user goal, the running summary, and the last
     * exchange remain. Beyond that there is nothing left to compact.
     */
    const MAX_COMPACTION_ROUNDS = 3;
    /** Raw summary text from the summarizer Lambda, persisted to DynamoDB after the loop. */
    let contextSummary = null;

    /**
     * The user's original question for this session. Pinned at the very top of
     * the history during compaction so the model never loses topic across
     * repeated summarizations ("lost-in-the-middle" mitigation). Falls back to
     * the current message on the first turn (when there's nothing to compact
     * anyway).
     */
    const userGoal =
      Array.isArray(chatHistory) && chatHistory.length > 0 && chatHistory[0]?.user
        ? String(chatHistory[0].user)
        : userMessage;

    let history = claude.assembleHistory(lastMessages, userMessage)

    // Load existing context summary from DynamoDB if available (persisted from a prior compression)
    try {
      const sessionFetch = await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.SESSION_HANDLER,
        Payload: JSON.stringify({
          body: JSON.stringify({
            operation: "get_session",
            user_id: userId,
            session_id: sessionId,
          })
        }),
      }));
      const sessionData = JSON.parse(Buffer.from(sessionFetch.Payload).toString());
      if (sessionData.statusCode === 200) {
        const sessionBody = JSON.parse(sessionData.body);
        if (sessionBody.context_summary) {
          history = [
            { role: "user", content: [{ type: "text", text: `[CONVERSATION SUMMARY]\n${sessionBody.context_summary}` }] },
            { role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our earlier conversation and will continue naturally." }] },
            ...history
          ];
          logger.info("Loaded existing context summary from DynamoDB");
        }
      }
    } catch (fetchErr) {
      logger.error("Failed to fetch session for summary", { error: fetchErr?.message });
    }
    let fullDocs = {"content" : "", "sources" : []}
    let documentIndexMap = [];
    const { tools: currentTools, indexes: currentIndexes } = await getAllTools();

    let streamRetries = 0;

    /**
     * Latest token estimate for the request. Updated each loop iteration; the
     * final value is reported back to the client in the trailing metadata
     * frame (ContextUsage) so the UI can render the live memory indicator.
     */
    let estimatedTokens = 0;

    /**
     * Maximum retries for transient Bedrock errors (throttles, timeouts,
     * 5xx). 3 retries with no backoff is enough to ride out brief throttle
     * bursts without making the user wait excessively.
     */
    const MAX_STREAM_RETRIES = 3;

    // ===== AGENTIC LOOP =====
    // Each iteration: estimate tokens -> compress/trim if needed -> stream
    // one Bedrock response -> either execute tools and loop, or finalize.
    while (!stopLoop) {
      logger.info("Starting stream", { attempt: streamRetries });

      estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);

      // ===== TIERED IN-SESSION COMPACTION =====
      // Industry-standard "two-tier sliding window with recursive summarization"
      // (LangChain ConversationSummaryBufferMemory; Claude Code auto-compact).
      // Each round is more aggressive than the last:
      //   Round 1: keep last 4 turns verbatim, summarize the rest.
      //   Round 2: keep last 2 turns verbatim, re-summarize the running summary,
      //            and aggressively trim large tool-result document blocks.
      //   Round 3: keep last 2 turns verbatim, drop ALL tool-result document
      //            blocks (only text remains alongside the pinned goal + summary).
      // The user's original question is pinned at the top through every round
      // so the model never loses the conversation topic.
      while (estimatedTokens > COMPRESSION_THRESHOLD && compactionRounds < MAX_COMPACTION_ROUNDS) {
        const round = compactionRounds + 1;
        logger.info("Compacting context", { round, estimatedTokens });

        const keepLastN = round === 1 ? 4 : 2;
        try {
          const result = await summarizeHistory(history, id, { keepLastN, userGoal });
          if (result) {
            history = result.compressedHistory;
            contextSummary = result.summaryText;
          }
        } catch (compressErr) {
          logger.error("Compaction round failed", { round, error: compressErr?.message });
          // Continue to in-place document trimming as a fallback for this round.
        }

        // Round 2+: trim oversized tool-result document blocks in place.
        if (round >= 2) {
          const TRIM_THRESHOLD = round === 2 ? 5000 : 0;
          for (const msg of history) {
            if (!Array.isArray(msg.content)) continue;
            for (const block of msg.content) {
              if (block.type !== "document" || !block.source?.data) continue;
              if (block.source.data.length <= TRIM_THRESHOLD) continue;
              try {
                const parsed = JSON.parse(block.source.data);
                block.source.data = JSON.stringify({
                  total_matches: parsed.total_matches,
                  returned: 0,
                  rows: [],
                  _trimmed_by_overflow: true,
                  _note: "Results trimmed to fit context. Use count_unique, group_by, or narrower filters.",
                });
              } catch (_) {
                block.source.data = '{"_trimmed_by_overflow":true,"rows":[],"returned":0}';
              }
            }
          }
        }

        compactionRounds = round;
        estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
        logger.info("Compaction round complete", { round, estimatedTokens });

        // Persist the running summary mid-loop too, so a page-refresh after a
        // very long turn still resumes from the latest compaction.
        if (contextSummary) {
          try {
            await lambdaClient.send(new InvokeCommand({
              FunctionName: process.env.SESSION_HANDLER,
              Payload: JSON.stringify({
                body: JSON.stringify({
                  operation: "update_context_summary",
                  user_id: userId,
                  session_id: sessionId,
                  context_summary: contextSummary,
                })
              }),
            }));
          } catch (sumErr) {
            logger.warn("Mid-loop summary persist failed", { error: sumErr?.message });
          }
        }
      }

      // Final safety net: if even after all compaction rounds we're over the
      // hard limit, emit a friendly inline assistant note (not a control
      // frame). This persists in the session and tells the user how to
      // continue without breaking the UI.
      if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
        logger.error("Context still too large after all compaction rounds", { estimatedTokens, compactionRounds });
        try {
          await safeSend({ ConnectionId: id, Data: "!<|STATUS|>!Preparing handoff summary..." });
        } catch (statusErr) {
          logger.warn("Handoff status send failed", { error: statusErr?.message });
        }
        const handoffBrief = await generateHandoffSummary({
          userGoal,
          currentMessage: userMessage,
          contextSummary,
          lastMessages,
        });
        const inlineNote = formatContextOverflowMessage(handoffBrief);
        try {
          await safeSend({ ConnectionId: id, Data: inlineNote });
        } catch (sendErr) {
          logger.warn("Inline-note send failed", { error: sendErr?.message });
        }
        modelResponse = inlineNote;
        stopLoop = true;
        break;
      }

      // Client deliberately left (pressed stop / closed tab) — don't spend
      // another Bedrock call; the abort signal also tears down any in-flight
      // stream. A network drop (connectionGone without clientStopped) falls
      // through: the loop keeps running so the answer can be finished and saved.
      if (connectionGone && clientStopped) {
        stopLoop = true;
        break;
      }

      let stream;
      try {
        stream = await claude.getStreamedResponse(SYS_PROMPT, history, currentTools, streamAbortController.signal);
      } catch (modelError) {
        logger.error("Model invocation failed", { error: modelError?.message, name: modelError?.name });
        // Detect context-window overflow surfaced by Bedrock as a ValidationException
        // (e.g., "Input is too long for requested model"). Generate a handoff brief
        // and emit it as an inline assistant message so the user can paste it into
        // a fresh chat to continue. Falls back to a plain notice on summary failure.
        const msg = (modelError?.message || "").toLowerCase();
        const isContextOverflow =
          modelError?.name === "ValidationException" &&
          (msg.includes("too long") || msg.includes("context") || msg.includes("max tokens") || msg.includes("input length"));
        if (isContextOverflow) {
          try {
            await safeSend({ ConnectionId: id, Data: "!<|STATUS|>!Preparing handoff summary..." });
          } catch (statusErr) {
            logger.warn("Handoff status send failed", { error: statusErr?.message });
          }
          const handoffBrief = await generateHandoffSummary({
            userGoal,
            currentMessage: userMessage,
            contextSummary,
            lastMessages,
          });
          const inlineNote = formatContextOverflowMessage(handoffBrief);
          try {
            await safeSend({ ConnectionId: id, Data: inlineNote });
          } catch (sendErr) {
            logger.warn("Inline-note send failed", { error: sendErr?.message });
          }
          modelResponse = inlineNote;
        } else {
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
            });
          } catch (sendErr) {
            logger.warn("Error send failed", { error: sendErr?.message });
          }
        }
        break;
      }

      // --- Stream processing: accumulate text + tool_use deltas ---
      /**
       * Accumulated text from the current Bedrock response (before final
       * flush). Declared outside the try: the catch below reads it on client
       * cancel, and a declaration inside the try would be out of scope there
       * (a past ReferenceError turned every mid-stream stop press into an
       * unhandled error).
       */
      let currentIterationText = "";
      try {
        /** Native Bedrock citations collected during this iteration. */
        let currentIterationCitations = [];
        /**
         * Timestamp of the last STATUS frame we sent to the client this iteration.
         * The frontend's WebSocket hook treats long silences as a stalled request
         * and disconnects after ~90s of no activity. While the model is composing
         * a long answer (text deltas accumulate server-side, nothing flushes until
         * stop_reason), we'd otherwise go silent for the full generation. Sending
         * a "Composing answer..." heartbeat every HEARTBEAT_INTERVAL_MS keeps the
         * socket alive so the final response actually reaches the UI.
         */
        let lastStatusSentAt = Date.now();
        /**
         * Map of content-block index -> { id, name, inputJson } for tool calls.
         * Claude can request multiple tools in a single response (batched /
         * parallel tool use). Each tool_use content block arrives as a
         * content_block_start event followed by incremental input_json_delta
         * events. We accumulate them here and execute them all when the
         * stream ends with stop_reason "tool_use".
         */
        const pendingTools = new Map();

        for await (const event of stream) {
          const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
          const parsedChunk = await claude.parseChunk(chunk);
          if (!parsedChunk) continue;

          // --- STATE TRANSITION: stop_reason determines next action ---
          // "tool_use"  -> execute pending tools, append results, continue loop
          // "end_turn"  -> finalize citations, stream answer, exit loop
          // "max_tokens"-> same as end_turn (partial answer is better than none)
          if (parsedChunk.stop_reason) {
            if (parsedChunk.stop_reason === "tool_use") {
              // All tool_use blocks and their input deltas have arrived; execute them
              const toolCalls = [...pendingTools.values()];
              toolRoundCount += toolCalls.length;
              if (toolRoundCount > MAX_TOOL_ROUNDS) {
                // Logged for ops visibility (CloudWatch alarms can pick this up),
                // but intentionally NOT surfaced to the user -- a confusing
                // "max iterations" message is worse UX than just ending the
                // turn with whatever the model has already produced.
                logger.error("Exceeded MAX_TOOL_ROUNDS, exiting loop silently", { toolRoundCount, MAX_TOOL_ROUNDS });
                stopLoop = true;
                break;
              }
              logger.info("Tool round", { calls: toolCalls.length, cumulative: toolRoundCount, max: MAX_TOOL_ROUNDS });

              // Build the assistant message with text + all tool_use blocks
              const assistantContent = [];
              if (currentIterationText.length > 0) {
                assistantContent.push({ type: "text", text: currentIterationText });
              }

              let allParsed = true;
              for (const tc of toolCalls) {
                try {
                  tc.parsedInput = JSON.parse(tc.inputJson);
                } catch (parseError) {
                  logger.error("Failed to parse tool input", { tool: tc.name, id: tc.id, error: parseError?.message });
                  tc.parsedInput = null;
                  allParsed = false;
                }
                assistantContent.push({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.name,
                  input: tc.parsedInput ?? {},
                });
              }
              history.push({ role: "assistant", content: assistantContent });

              if (!allParsed && toolCalls.length === 1 && toolCalls[0].parsedInput === null) {
                history.push({
                  role: "user",
                  content: [{
                    type: "tool_result",
                    tool_use_id: toolCalls[0].id,
                    content: "Error: could not process the tool input. Please respond to the user without using tools."
                  }]
                });
                pendingTools.clear();
                currentIterationText = "";
                currentIterationCitations = [];
                continue;
              }

              // Execute tools sequentially (not Promise.all) to avoid race conditions
              // on the shared fullDocs.sources array -- each tool appends sources with
              // monotonically increasing chunkIndex values used for citation mapping.
              const toolResults = [];
              for (const tc of toolCalls) {
                const query = tc.parsedInput;
                if (query === null) {
                  toolResults.push({ toolId: tc.id, content: `Error: the input for tool "${tc.name}" could not be parsed as valid JSON. Please retry with a correctly structured JSON object matching the tool's schema.`, documentBlocks: [] });
                  continue;
                }

                if (tc.name === "query_db") {
                  const withinDocument = query.within_document || null;
                  logger.info("Tool call: query_db", { within_document: withinDocument });
                  const statusQuery = truncate(query.query);
                  const statusDoc = truncate(withinDocument);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: statusDoc
                        ? `!<|STATUS|>!Searching "${statusDoc}" for "${statusQuery}"...`
                        : statusQuery
                          ? `!<|STATUS|>!Searching documents for "${statusQuery}"...`
                          : "!<|STATUS|>!Searching documents..."
                    });
                  } catch (statusErr) {
                    logger.warn("Status send failed", { error: statusErr?.message });
                  }
                  const docResult = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID, fullDocs.sources.length, { withinDocument });
                  fullDocs.sources = fullDocs.sources.concat(docResult.sources);
                  for (const src of docResult.sources) {
                    documentIndexMap.push(src);
                  }
                  const text = docResult.documentBlocks.length > 0
                    ? `Retrieved ${docResult.documentBlocks.length} relevant documents. Analyze the attached documents to answer the user's question.`
                    : docResult.content;
                  logger.info("Tool result: query_db", { docCount: docResult.documentBlocks.length });
                  toolResults.push({ toolId: tc.id, content: text, documentBlocks: docResult.documentBlocks });

                } else if (tc.name === "retrieve_full_document") {
                  logger.info("Tool call: retrieve_full_document", { document_name: query.document_name });
                  const docNameDisplay = truncate(query.document_name);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: `!<|STATUS|>!Retrieving full document "${docNameDisplay}"...`
                    });
                  } catch (statusErr) {
                    logger.warn("Status send failed", { error: statusErr?.message });
                  }
                  const fullDocResult = await retrieveFullDocument(
                    query.document_name, knowledgeBase, process.env.KB_ID,
                    query.query_context || null, fullDocs.sources.length
                  );
                  fullDocs.sources = fullDocs.sources.concat(fullDocResult.sources);
                  for (const src of fullDocResult.sources) {
                    documentIndexMap.push(src);
                  }
                  const text = fullDocResult.documentBlocks.length > 0
                    ? `Retrieved complete document "${query.document_name}" (${fullDocResult.documentBlocks.length} chunks). Analyze the attached document blocks — they contain the full document in page order.`
                    : fullDocResult.content;
                  logger.info("Tool result: retrieve_full_document", { chunkCount: fullDocResult.documentBlocks.length });
                  toolResults.push({ toolId: tc.id, content: text, documentBlocks: fullDocResult.documentBlocks });

                } else if (tc.name === "fetch_metadata") {
                  const full = query?.full === true;
                  logger.info("Tool call: fetch_metadata", { full });
                  try {
                    await safeSend({
                      ConnectionId: id, Data: "!<|STATUS|>!Fetching contract metadata..."
                    });
                  } catch (statusErr) {
                    logger.warn("Status send failed", { error: statusErr?.message });
                  }
                  const metadata = await fetchMetadata({ full });
                  logger.info("Tool result: fetch_metadata");
                  toolResults.push({ toolId: tc.id, content: metadata ? JSON.stringify(metadata) : "No metadata available.", documentBlocks: [] });

                } else if (tc.name === "query_excel_index") {
                  const indexName = query.index_name;
                  const idxMeta = currentIndexes.find(i => i.index_name === indexName);
                  const displayName = idxMeta?.display_name || indexName;
                  const searchTerm = truncate(query.free_text);
                  logger.info("Tool call: query_excel_index", { indexName });
                  let statusMsg;
                  if (searchTerm) {
                    statusMsg = `Searching ${displayName} for "${searchTerm}"...`;
                  } else if (query.filters && Object.keys(query.filters).length > 0) {
                    statusMsg = `Searching ${displayName} with filters...`;
                  } else {
                    statusMsg = `Searching ${displayName}...`;
                  }
                  try {
                    await safeSend({ ConnectionId: id, Data: `!<|STATUS|>!${statusMsg}` });
                  } catch (statusErr) {
                    logger.warn("Status send failed", { error: statusErr?.message });
                  }
                  let toolResultContent = await invokeIndexQuery({
                    action: "query",
                    index_name: indexName,
                    free_text: query.free_text || null,
                    filters: query.filters || null,
                    date_before: query.date_before || null,
                    date_after: query.date_after || null,
                    columns: Array.isArray(query.columns) ? query.columns : null,
                    count_only: query.count_only === true,
                    count_unique: query.count_unique || null,
                    group_by: query.group_by || null,
                    group_by_value_max: query.group_by_value_max || null,
                    distinct_values: query.distinct_values || null,
                    min_value: query.min_value || null,
                    max_value: query.max_value || null,
                    sort_by: query.sort_by || null,
                    sort_order: query.sort_order || "asc",
                    limit: typeof query.limit === "number" ? query.limit : 100,
                    offset: typeof query.offset === "number" ? query.offset : 0,
                  });

                  toolResultContent = await enrichExcelIndexResult(query, indexName, toolResultContent, idxMeta);
                  toolResultContent = capToolResultSize(toolResultContent);

                  const excelSourceIndex = fullDocs.sources.length + 1;
                  let excelExcerpt = "";
                  try {
                    const resultData = JSON.parse(toolResultContent);
                    excelExcerpt = `${resultData.total_matches || 0} rows matched`;
                    if (query.free_text) excelExcerpt += ` for "${query.free_text}"`;
                    if (query.filters && Object.keys(query.filters).length > 0) {
                      excelExcerpt += ` with filters: ${Object.entries(query.filters).map(([k,v]) => `${k}="${v}"`).join(", ")}`;
                    }
                  } catch (_) {
                    excelExcerpt = "Excel index query results";
                  }
                  const excelSource = {
                    chunkIndex: excelSourceIndex,
                    title: displayName,
                    uri: null,
                    excerpt: excelExcerpt,
                    score: null,
                    page: null,
                    s3Key: null,
                    sourceType: "excelIndex"
                  };
                  fullDocs.sources.push(excelSource);
                  documentIndexMap.push(excelSource);
                  const excelDocBlock = {
                    type: "document",
                    source: { type: "text", media_type: "text/plain", data: String(toolResultContent) },
                    title: `Source ${excelSourceIndex} - ${displayName} (Excel Data)`,
                    context: excelExcerpt,
                    citations: { enabled: true }
                  };
                  logger.info("Tool result: query_excel_index");
                  toolResults.push({ toolId: tc.id, content: `Excel query results from ${displayName}. Analyze the attached document.`, documentBlocks: [excelDocBlock] });

                } else {
                  logger.warn("Unknown tool requested", { tool: tc.name });
                  toolResults.push({ toolId: tc.id, content: "Unknown tool requested.", documentBlocks: [] });
                }
              }

              // Build the single user message with all tool_result blocks
              // Per Anthropic API: tool_result blocks must come FIRST, then document blocks
              const userContent = [];
              const allDocBlocks = [];
              for (const result of toolResults) {
                userContent.push({
                  type: "tool_result",
                  tool_use_id: result.toolId,
                  content: result.content,
                });
                if (result.documentBlocks && result.documentBlocks.length > 0) {
                  allDocBlocks.push(...result.documentBlocks);
                }
              }
              userContent.push(...allDocBlocks);
              history.push({ role: "user", content: userContent });

              // Clear any intermediate (pre-tool) text we streamed this round so
              // it doesn't sit in front of the final answer; the next iteration
              // streams fresh.
              if (currentIterationText.length > 0) {
                try {
                  await safeSend({ ConnectionId: id, Data: "!<|REPLACE|>!" });
                } catch (resetErr) {
                  logger.warn("Reset send failed", { error: resetErr?.message });
                }
              }

              try {
                await safeSend({ ConnectionId: id, Data: "!<|STATUS|>!Reading through the results..." });
              } catch (statusErr) {
                logger.warn("Status send failed", { error: statusErr?.message });
              }

              pendingTools.clear();
              currentIterationText = "";
              currentIterationCitations = [];

            } else {
              // Non-tool stop (end_turn, max_tokens, etc.)
              if (currentIterationText.length > 0) {
                if (currentIterationCitations.length > 0) {
                  currentIterationText = insertCitationMarkers(
                    currentIterationText, currentIterationCitations,
                    documentIndexMap, fullDocs.sources
                  );
                } else if (fullDocs.sources.length > 0) {
                  currentIterationText = validateSelfManagedCitations(
                    currentIterationText, fullDocs.sources
                  );
                }
                const renumbered = renumberCitations(currentIterationText, fullDocs.sources);
                currentIterationText = renumbered.text;
                fullDocs.sources = renumbered.sources;
                try {
                  // Replace the raw streamed text with the citation-finalized
                  // version in a single frame (no clear-then-redraw flicker).
                  await safeSend({ ConnectionId: id, Data: "!<|REPLACE|>!" + currentIterationText });
                } catch (err) {
                  logger.error("Error flushing final answer", { error: err?.message });
                }
              }
              modelResponse = currentIterationText;
              stopLoop = true;
              break;
            }
            continue;
          }

          // --- TOOL_USE block start: register a new pending tool call ---
          if (parsedChunk.type === "tool_use") {
            pendingTools.set(parsedChunk.index, {
              id: parsedChunk.id,
              name: parsedChunk.name,
              inputJson: "",
            });
            continue;
          }

          // --- STREAMING DELTAS: accumulate tool input JSON, text, or citations ---
          if (parsedChunk.kind === "tool_input" && parsedChunk.json != null) {
            const entry = pendingTools.get(parsedChunk.index);
            if (entry) {
              entry.inputJson += parsedChunk.json;
            }
          } else if (parsedChunk.kind === "text") {
            currentIterationText += parsedChunk.text;
            // Stream the raw delta so the answer renders live in the UI. The
            // citation-finalized version replaces it in one frame at end_turn
            // (see the !<|REPLACE|>! flush below).
            if (parsedChunk.text) {
              try {
                await safeSend({ ConnectionId: id, Data: parsedChunk.text });
              } catch (deltaErr) {
                logger.warn("Delta send failed", { error: deltaErr?.message });
              }
            }
          } else if (parsedChunk.kind === "citation") {
            currentIterationCitations.push({
              textOffset: currentIterationText.length,
              citation: parsedChunk.citation,
            });
          }

          // Heartbeat: keep the WebSocket alive during the "thinking" phase
          // (tool-call generation, before any answer text). Once text is
          // streaming the deltas keep the socket alive, so skip it then to
          // avoid a status pill flickering over the live answer.
          if (currentIterationText.length === 0 && Date.now() - lastStatusSentAt > 20_000) {
            lastStatusSentAt = Date.now();
            try {
              await safeSend({ ConnectionId: id, Data: "!<|STATUS|>!Composing answer…" });
            } catch (hbErr) {
              logger.warn("Heartbeat send failed", { error: hbErr?.message });
            }
          }
        }

      } catch (error) {
        // Client deliberately stopped: the Bedrock stream was aborted on
        // purpose. Stop cleanly — never log it as a failure or try to send an
        // error frame. (A network drop does not abort: the stream keeps
        // flowing with sends suppressed, so errors landing here while
        // connectionGone-but-not-stopped are real and take the retry path.)
        if ((connectionGone && clientStopped) || error?.name === 'AbortError') {
          logger.info("Stream cancelled by client disconnect", { partialChars: currentIterationText.length });
          stopLoop = true;
          break;
        }

        // --- RETRY LOGIC ---
        // Classify the error as transient or permanent. Transient errors
        // (throttles, timeouts, network blips) are retried up to
        // MAX_STREAM_RETRIES times by continuing the while(!stopLoop) loop.
        // Permanent errors (validation, auth, unknown) abort immediately.
        logger.error("Stream processing error", { error: error?.message, name: error?.name });
        const TRANSIENT_ERROR_NAMES = new Set([
          'ThrottlingException', 'ServiceUnavailableException',
          'InternalServerException', 'RequestTimeout',
          'ECONNRESET', 'ETIMEDOUT', 'NetworkingError',
        ]);
        const isTransient = TRANSIENT_ERROR_NAMES.has(error.name)
          || TRANSIENT_ERROR_NAMES.has(error.__type)
          || error.message?.toLowerCase().includes('timeout')
          || error.message?.toLowerCase().includes('throttl');
        if (!isTransient) {
          logger.error("Non-transient error, not retrying", { name: error?.name, message: error?.message });
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
            });
          } catch (sendErr) {
            logger.warn("Error send failed", { error: sendErr?.message });
          }
          stopLoop = true;
        } else {
          streamRetries++;
          if (streamRetries >= MAX_STREAM_RETRIES) {
            try {
              await safeSend({
                ConnectionId: id,
                Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
              });
            } catch (sendErr) {
              logger.warn("Error send failed", { error: sendErr?.message });
            }
            stopLoop = true;
          } else {
            logger.warn("Transient error, retrying", { attempt: streamRetries, max: MAX_STREAM_RETRIES });
          }
        }
      }

    }

    // Client deliberately disconnected (pressed stop / closed the tab): the
    // Bedrock stream is already aborted and the loop broken. Treat it as a
    // clean cancel — persist nothing (a deliberate stop must never reappear on
    // reload) and skip the finalize sends that would only hit a dead connection.
    if (connectionGone && clientStopped) {
      logger.info("Request cancelled by client; discarding partial and skipping save");
      return;
    }

    // Network drop: the socket died but the client never closed it (no clean
    // $disconnect). The answer was generated to completion above with sends
    // suppressed — fall through so it's traced and saved; a reload will show
    // the full exchange instead of losing the question and reply entirely.
    if (connectionGone) {
      logger.info("Connection dropped mid-stream; saving completed answer for reload", {
        chars: (modelResponse || "").length,
      });
    }

    // If the streaming loop ended without producing any model text (e.g. Bedrock
    // returned an empty content array, a guardrail intervened, or the model
    // refused to answer) and no inline note was emitted as the response,
    // surface a user-facing error frame. Without this the frontend only sees
    // EOF + metadata after zero text chunks and stays stuck on "Thinking...".
    const trimmedModelResponse = (modelResponse || "").trim();
    if (!trimmedModelResponse) {
      logger.error("Streaming loop produced no model output", { toolRoundCount, compactionRounds });
      try {
        await safeSend({
          ConnectionId: id,
          Data: "<!ERROR!>: I'm sorry, I wasn't able to generate a response for that question. Please try again or rephrase your question."
        });
      } catch (sendErr) {
        logger.warn("Empty-response error send failed", { error: sendErr?.message });
      }
    }

    let command;
    const messageId = randomUUID();
    const turnIndex = Array.isArray(chatHistory) ? chatHistory.length + 1 : 1;
    try {
      await writeResponseTrace({
        messageId,
        sessionId,
        turnIndex,
        userPrompt: userMessage,
        finalAnswer: modelResponse,
        sources: fullDocs.sources,
        promptVersionId: promptConfig.promptVersionId,
        promptTemplateHash: promptConfig.promptTemplateHash,
        modelId: claude.modelId,
        guardrailId: process.env.GUARDRAIL_ID || "",
        userId,
      });
    } catch (traceError) {
      logger.error("Failed to persist response trace", { error: traceError?.message });
    }
    const usagePercent = Math.min(
      100,
      Math.max(0, Math.round((estimatedTokens / MAX_ESTIMATED_TOKENS) * 100))
    );
    const responseMetadata = JSON.stringify({
      Sources: fullDocs.sources,
      Trace: {
        messageId,
        sessionId,
        promptVersionId: promptConfig.promptVersionId,
        promptTemplateHash: promptConfig.promptTemplateHash,
        turnIndex,
      },
      ContextUsage: {
        estimatedTokens,
        maxTokens: MAX_ESTIMATED_TOKENS,
        percent: usagePercent,
        compactionRounds,
      },
    });
    // Send end-of-stream + metadata, then immediately release the client. The
    // browser has everything it needs to render the full answer at this point,
    // so the remaining work below (FAQ classification, title generation, session
    // save, context summary) is server-side only and must not hold the socket
    // open: a slow or failed step there previously delayed — or skipped — the
    // close, leaving the UI stuck mid-stream on the stop button.
    try {
      await safeSend({ ConnectionId: id, Data: "!<|EOF_STREAM|>!" });
      await safeSend({ ConnectionId: id, Data: responseMetadata });
    } catch (e) {
      logger.error("Error sending EOF_STREAM and sources", { error: e?.message });
    }

    if (!connectionGone) {
      try {
        await wsConnectionClient.send(new DeleteConnectionCommand({ ConnectionId: id }));
        connectionGone = true;
      } catch (disconnectErr) {
        // GoneException (410) means the client already closed the socket --
        // there's nothing to clean up, so don't emit a "failed" line that
        // pollutes error-grep queries over the logs.
        if (disconnectErr?.name === 'GoneException' || disconnectErr?.$metadata?.httpStatusCode === 410) {
          connectionGone = true;
        } else {
          logger.warn("Connection cleanup failed", { error: disconnectErr?.message, name: disconnectErr?.name });
        }
      }
    }

    // Async FAQ classification (fire-and-forget)
    if (process.env.FAQ_CLASSIFIER_FUNCTION) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.FAQ_CLASSIFIER_FUNCTION,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            userMessage,
            userId,
            sessionId,
            displayName,
            agency,
            timestamp: new Date().toISOString(),
          }),
        }));
      } catch (classifyErr) {
        logger.error("FAQ classification fire-and-forget failed", { error: classifyErr?.message });
      }
    }

    let title = "";
    const finalResponse = modelResponse || "I'm sorry, I was unable to generate a response. Please try again.";
    let newChatEntry = { "user": userMessage, "chatbot": finalResponse, "metadata": responseMetadata };
    if (isFirstTurn) {
      try {
        let titleModel = new ClaudeModel(process.env.FAST_MODEL_ID);
        title = await titleModel.getResponse(
          "Generate a short title (3-8 words) summarizing the USER's question topic. Rules: output ONLY the title, no quotes, no explanation, no apologies. Focus on what the user is asking about, not the assistant's response. Examples: 'HVAC Trade Vendor Contracts', 'W.B. Mason Contract Lookup', 'Laptop Procurement Process'.",
          [],
          `User: ${userMessage}`,
          { maxTokens: 15 }
        );
        title = title.replaceAll(`"`, '').trim();
        if (title.length > 80) {
          title = userMessage.substring(0, 75).trim();
        }
      } catch (titleError) {
        logger.error("Title generation failed", { error: titleError?.message });
        title = userMessage.substring(0, 50);
      }
    }

    const sessionSaveRequest = {
      body: JSON.stringify({
        "operation": "append_chat_entry",
        "user_id": userId,
        "session_id": sessionId,
        "new_chat_entry": newChatEntry,
        "title": title
      })
    }

    const lambdaSaveCommand = new InvokeCommand({
      FunctionName: process.env.SESSION_HANDLER,
      Payload: JSON.stringify(sessionSaveRequest),
    });

    const saveResponse = await lambdaClient.send(lambdaSaveCommand);
    if (saveResponse.Payload) {
      try {
        const parsedSave = JSON.parse(Buffer.from(saveResponse.Payload).toString());
        if (parsedSave.statusCode && parsedSave.statusCode >= 400) {
          logger.error("Session save failed", { body: parsedSave.body });
        }
      } catch (saveParseError) {
        logger.error("Failed to parse session save response", { error: saveParseError?.message });
      }
    }

    // Persist context summary to DynamoDB so it survives page reloads
    if (contextSummary) {
      try {
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.SESSION_HANDLER,
          Payload: JSON.stringify({
            body: JSON.stringify({
              operation: "update_context_summary",
              user_id: userId,
              session_id: sessionId,
              context_summary: contextSummary,
            })
          }),
        }));
        logger.info("Context summary persisted to DynamoDB");
      } catch (sumErr) {
        logger.error("Failed to save context summary", { error: sumErr?.message });
      }
    }

  } catch (error) {
    logger.error("Unhandled error in getUserResponse", { error: error?.message, stack: error?.stack });
    try {
      const errorTraceId = randomUUID();
      await writeResponseTrace({
        messageId: errorTraceId,
        sessionId: requestJSON?.data?.session_id || "unknown",
        turnIndex: 0,
        userPrompt: requestJSON?.data?.userMessage || "",
        finalAnswer: "",
        sources: [],
        promptVersionId: "error",
        promptTemplateHash: "",
        modelId: "",
        guardrailId: "",
        userId: authorizedUserId,
      });
    } catch (traceErr) {
      logger.error("Failed to write error trace", { error: traceErr?.message });
    }
    try {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id,
        Data: "<!ERROR!>: I'm sorry, something went wrong. Please try again or rephrase your question."
      }));
    } catch (sendErr) {
      logger.warn("Final error send failed", { error: sendErr?.message });
    }
  }
}

/**
 * Lambda handler for the WebSocket API Gateway integration.
 *
 * Routes:
 *   - $connect: no-op (connection lifecycle managed by APIGW).
 *   - $disconnect: records a clean-close marker so an in-flight streaming
 *     invocation can tell a deliberate stop from a silent network drop.
 *   - getChatbotResponse: delegates to {@link getUserResponse}.
 *   - $default: catch-all (returns a default action string).
 *
 * @param {Object} event - API Gateway WebSocket event.
 * @returns {Promise<{statusCode: number}>}
 */
export const handler = async (event) => {
  if (event.requestContext) {
    const connectionId = event.requestContext.connectionId;
    const routeKey = event.requestContext.routeKey;
    let body = {};
    try {
      if (event.body) {
        body = JSON.parse(event.body);
      }
    } catch (err) {
      logger.error("Failed to parse request body", { error: err?.message });
    }
    logger.info("WebSocket route", { routeKey });

    switch (routeKey) {
      case '$connect':
        logger.info("WebSocket connect", { connectionId });
        return { statusCode: 200 };
      case '$disconnect':
        logger.info("WebSocket disconnect", {
          connectionId,
          statusCode: event.requestContext.disconnectStatusCode,
          reason: event.requestContext.disconnectReason,
        });
        // Marker tells an in-flight streaming invocation this was a clean
        // client close (deliberate stop) rather than a silent network drop.
        await writeDisconnectMarker(connectionId);
        return { statusCode: 200 };
      case '$default':
        return { 'action': 'Default Response Triggered' }
      case "getChatbotResponse": {
        // Pull the JWT-verified identifier from the WS authorizer context
        // that ran at $connect. API Gateway caches and propagates authorizer
        // context to every route on the connection, so we always have a
        // trusted user id here (no need to rely on the client-supplied body).
        //
        // Prefer `cognito_username` because historical chat rows are keyed
        // off that (matches Amplify's `.username` in the frontend); fall back
        // to `principalId` (the JWT `sub`) for older connections that
        // pre-date the cognito_username addition.
        const authorizer = event.requestContext.authorizer || {};
        const authorizedUserId = authorizer.cognito_username || authorizer.principalId || null;
        await getUserResponse(connectionId, body, authorizedUserId)
        return { statusCode: 200 };
      }
      default:
        return {
          statusCode: 404,  // 'Not Found' status code
          body: JSON.stringify({
            error: "The requested route is not recognized."
          })
        };
    }
  }
  return {
    statusCode: 200,
  };
};
