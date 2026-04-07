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
 */

import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
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
 * Splits the history into two segments:
 *   - "toSummarize": all messages except the last 4 -- fed to the summarizer.
 *   - "toKeep": the most recent 2 user/assistant exchange pairs (4 messages),
 *     preserved verbatim so the model retains immediate conversational context.
 *
 * The summary is injected as a synthetic [CONVERSATION SUMMARY] user message
 * at the start of the returned history, giving the model condensed context
 * from earlier turns without consuming proportional token budget.
 *
 * @param {Array<{role: string, content: *}>} history - Full conversation history in Bedrock format.
 * @param {string} connectionId - WebSocket connection ID (used to send a "Thinking..." status).
 * @returns {Promise<{compressedHistory: Array, summaryText: string} | null>}
 *   The compressed history and raw summary text, or null if there are fewer
 *   than 2 messages eligible for summarization (nothing worth compressing).
 */
async function summarizeHistory(history, connectionId) {
  // Send a neutral status so the user sees the thinking indicator
  try {
    await wsConnectionClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: "!<|STATUS|>!Thinking\u2026"
    }));
  } catch (statusErr) {
    logger.warn("Status send failed", { error: statusErr?.message });
  }

  // Keep the last 4 messages (2 user/assistant pairs) intact
  const toSummarize = history.slice(0, -4);
  const toKeep = history.slice(-4);

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

  const compressedHistory = [
    { role: "user", content: [{ type: "text", text: `[CONVERSATION SUMMARY]\n${summaryText}` }] },
    { role: "assistant", content: [{ type: "text", text: "Understood. I have the context from our earlier conversation and will continue naturally." }] },
    ...toKeep
  ];

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
}) {
  const tableName = process.env.RESPONSE_TRACE_TABLE;
  if (!tableName) {
    return;
  }

  const createdAt = new Date().toISOString();
  await ddbClient.send(new PutItemCommand({
    TableName: tableName,
    Item: {
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
    },
  }));
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
const getUserResponse = async (id, requestJSON) => {
  try {
    const data = requestJSON?.data;

    if (!data || typeof data !== 'object') {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: "<!ERROR!>: Invalid request format."
      }));
      return;
    }

    let userMessage = data.userMessage;
    const userId = data.user_id;
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
    if (!userId || !sessionId) {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id, Data: "<!ERROR!>: Missing user_id or session_id."
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
     * safeSend wraps every WebSocket PostToConnection call. It:
     *   1. Short-circuits immediately if connectionGone is true (no-op).
     *   2. Catches GoneException (HTTP 410) and flips connectionGone.
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
          }
          return;
        }
        throw err;
      }
    };

    /** Running total of tool invocations across all loop iterations. */
    let toolRoundCount = 0;

    /**
     * Safety cap on total tool calls per request. 20 rounds is generous --
     * most queries resolve in 1-3 tool calls. This prevents runaway loops
     * where the model repeatedly calls tools without converging on an answer
     * (e.g., cycling between overlapping KB queries).
     */
    const MAX_TOOL_ROUNDS = 20;

    /** Whether context compression has already been applied this request. */
    let contextCompressed = false;
    /** Raw summary text from the summarizer Lambda, persisted to DynamoDB after the loop. */
    let contextSummary = null;

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

      let estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);

      // Auto-compress: summarize older history when context exceeds 75% capacity
      if (estimatedTokens > COMPRESSION_THRESHOLD && !contextCompressed) {
        logger.info("Compressing context", { estimatedTokens });
        try {
          const result = await summarizeHistory(history, id);
          if (result) {
            history = result.compressedHistory;
            contextSummary = result.summaryText;
            contextCompressed = true;
            estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
            logger.info("Context compressed", { estimatedTokens });
          }
        } catch (compressErr) {
          logger.error("Context compression failed", { error: compressErr?.message });
          // Fall through to existing overflow handling
        }
        estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
      }

      // --- Hard-limit overflow: aggressively strip large tool results ---
      // This path fires only when compression was insufficient or skipped.
      // It replaces the payload of any document block larger than 5K chars
      // with a minimal stub, keeping metadata but dropping row data.
      if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
        logger.error("Context too large, aggressively trimming", { estimatedTokens });
        /**
         * Per-block character threshold for aggressive trimming. 5K chars
         * (~1.4K tokens) is large enough to preserve small tool results
         * while gutting the big ones (Excel queries can return 50K+ chars).
         */
        const AGGRESSIVE_TRIM_THRESHOLD = 5000;
        let trimmed = false;
        for (const msg of history) {
          if (!Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (block.type === "document" && block.source?.data && block.source.data.length > AGGRESSIVE_TRIM_THRESHOLD) {
              try {
                const parsed = JSON.parse(block.source.data);
                block.source.data = JSON.stringify({
                  total_matches: parsed.total_matches,
                  returned: 0,
                  rows: [],
                  _trimmed_by_overflow: true,
                  _note: `Results trimmed to fit context. Use count_unique, group_by, or narrower filters.`
                });
                trimmed = true;
              } catch (_) {
                block.source.data = '{"_trimmed_by_overflow":true,"rows":[],"returned":0}';
                trimmed = true;
              }
            }
          }
          estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
          if (estimatedTokens <= MAX_ESTIMATED_TOKENS) break;
        }
        estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
        if (estimatedTokens > MAX_ESTIMATED_TOKENS || !trimmed) {
          logger.error("Context still too large after trim, aborting", { estimatedTokens });
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: The conversation has accumulated too much data to process. Please start a new conversation or ask a more specific question."
            });
          } catch (sendErr) {
            logger.warn("Error send failed", { error: sendErr?.message });
          }
          break;
        }
        logger.info("Trimmed context, continuing", { estimatedTokens });
      }

      let stream;
      try {
        stream = await claude.getStreamedResponse(SYS_PROMPT, history, currentTools);
      } catch (modelError) {
        logger.error("Model invocation failed", { error: modelError?.message, name: modelError?.name });
        try {
          await safeSend({
            ConnectionId: id,
            Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
          });
        } catch (sendErr) {
          logger.warn("Error send failed", { error: sendErr?.message });
        }
        break;
      }

      // --- Stream processing: accumulate text + tool_use deltas ---
      try {
        /** Accumulated text from the current Bedrock response (before final flush). */
        let currentIterationText = "";
        /** Native Bedrock citations collected during this iteration. */
        let currentIterationCitations = [];
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
                logger.error("Exceeded MAX_TOOL_ROUNDS", { toolRoundCount, MAX_TOOL_ROUNDS });
                try {
                  await safeSend({
                    ConnectionId: id,
                    Data: "I've reached the maximum number of search iterations for this question. Here's what I found so far based on my research."
                  });
                } catch (statusErr) {
                  logger.warn("Status send failed", { error: statusErr?.message });
                }
                modelResponse = "I've reached the maximum number of search iterations. Please try rephrasing your question or asking something more specific.";
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
                  logger.info("Tool call: query_db");
                  const statusQuery = truncate(query.query);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: statusQuery
                        ? `!<|STATUS|>!Searching documents for "${statusQuery}"...`
                        : "!<|STATUS|>!Searching documents..."
                    });
                  } catch (statusErr) {
                    logger.warn("Status send failed", { error: statusErr?.message });
                  }
                  const docResult = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID, fullDocs.sources.length);
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
                  logger.info("Tool call: fetch_metadata");
                  try {
                    await safeSend({
                      ConnectionId: id, Data: "!<|STATUS|>!Fetching contract metadata..."
                    });
                  } catch (statusErr) {
                    logger.warn("Status send failed", { error: statusErr?.message });
                  }
                  const metadata = await fetchMetadata();
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
                  await safeSend({ ConnectionId: id, Data: currentIterationText });
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
          } else if (parsedChunk.kind === "citation") {
            currentIterationCitations.push({
              textOffset: currentIterationText.length,
              citation: parsedChunk.citation,
            });
          }
        }

      } catch (error) {
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
      });
    } catch (traceError) {
      logger.error("Failed to persist response trace", { error: traceError?.message });
    }
    const responseMetadata = JSON.stringify({
      Sources: fullDocs.sources,
      Trace: {
        messageId,
        sessionId,
        promptVersionId: promptConfig.promptVersionId,
        promptTemplateHash: promptConfig.promptTemplateHash,
        turnIndex,
      },
    });
    // send end of stream message
    try {
      await safeSend({ ConnectionId: id, Data: "!<|EOF_STREAM|>!" });
      await safeSend({ ConnectionId: id, Data: responseMetadata });
    } catch (e) {
      logger.error("Error sending EOF_STREAM and sources", { error: e?.message });
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

    if (!connectionGone) {
      try {
        await wsConnectionClient.send(new DeleteConnectionCommand({ ConnectionId: id }));
      } catch (disconnectErr) {
        logger.warn("Connection cleanup failed", { error: disconnectErr?.message });
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
 *   - $connect / $disconnect: no-op (connection lifecycle managed by APIGW).
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
        logger.info("WebSocket disconnect", { connectionId });
        return { statusCode: 200 };
      case '$default':
        return { 'action': 'Default Response Triggered' }
      case "getChatbotResponse":
        await getUserResponse(connectionId, body)
        return { statusCode: 200 };
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
