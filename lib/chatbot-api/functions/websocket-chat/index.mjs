import { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import ClaudeModel from "./models/chat-model.mjs";
import { randomUUID } from "crypto";

import { insertCitationMarkers, validateSelfManagedCitations, renumberCitations } from './citations.mjs';
import { retrieveKBDocs, retrieveFullDocument } from './kb.mjs';
import { STATIC_TOOLS, truncate, capToolResultSize, getAllTools, fetchMetadata, enrichExcelIndexResult, invokeIndexQuery, constructSysPrompt } from './tools.mjs';



/*global fetch*/

const ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;
const wsConnectionClient = new ApiGatewayManagementApiClient({ endpoint: ENDPOINT });

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const lambdaClient = new LambdaClient({});

const MAX_ESTIMATED_TOKENS = 160000;
const COMPRESSION_THRESHOLD = 120000;

function estimateTokens(systemPrompt, history, tools) {
  const chars = systemPrompt.length + JSON.stringify(history).length + JSON.stringify(tools).length;
  return Math.ceil(chars / 3.5);
}

/**
 * Compress older conversation history by summarizing it via the context-summarizer Lambda.
 * Keeps the most recent 2 exchange pairs (4 messages) verbatim for immediate context.
 * Returns { compressedHistory, summaryText } or null if not enough history to compress.
 */
async function summarizeHistory(history, connectionId) {
  // Send a neutral status so the user sees the thinking indicator
  try {
    await wsConnectionClient.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: "!<|STATUS|>!Thinking\u2026"
    }));
  } catch (statusErr) {
    console.warn("Status send failed:", statusErr);
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

const MAX_MESSAGE_LENGTH = 10_000;

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
    let connectionGone = false;
    const safeSend = async (params) => {
      if (connectionGone) return;
      try {
        await wsConnectionClient.send(new PostToConnectionCommand(params));
      } catch (err) {
        if (err.name === 'GoneException' || err.$metadata?.httpStatusCode === 410) {
          if (!connectionGone) {
            console.warn('Client disconnected (GoneException). Suppressing further send attempts.');
            connectionGone = true;
          }
          return;
        }
        throw err;
      }
    };
    let toolRoundCount = 0;
    const MAX_TOOL_ROUNDS = 20;
    let contextCompressed = false;
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
          console.log("Loaded existing context summary from DynamoDB.");
        }
      }
    } catch (fetchErr) {
      console.error("Failed to fetch session for summary:", fetchErr);
    }
    let fullDocs = {"content" : "", "sources" : []}
    let documentIndexMap = [];
    const { tools: currentTools, indexes: currentIndexes } = await getAllTools();

    let streamRetries = 0;
    const MAX_STREAM_RETRIES = 3;
    while (!stopLoop) {
      console.log("started new stream")
      history.forEach((historyItem) => {
        console.log(historyItem)
      })

      let estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);

      // Auto-compress: summarize older history when context exceeds 75% capacity
      if (estimatedTokens > COMPRESSION_THRESHOLD && !contextCompressed) {
        console.log(`Context at ~${estimatedTokens} tokens (>${COMPRESSION_THRESHOLD}). Compressing.`);
        try {
          const result = await summarizeHistory(history, id);
          if (result) {
            history = result.compressedHistory;
            contextSummary = result.summaryText;
            contextCompressed = true;
            estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
            console.log(`Compressed context to ~${estimatedTokens} tokens.`);
          }
        } catch (compressErr) {
          console.error("Context compression failed:", compressErr);
          // Fall through to existing overflow handling
        }
        estimatedTokens = estimateTokens(SYS_PROMPT, history, currentTools);
      }

      if (estimatedTokens > MAX_ESTIMATED_TOKENS) {
        console.error(`Context too large: ~${estimatedTokens} tokens. Aggressively trimming tool results.`);
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
          console.error(`Context still too large after trim: ~${estimatedTokens} tokens. Aborting.`);
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: The conversation has accumulated too much data to process. Please start a new conversation or ask a more specific question."
            });
          } catch (sendErr) {
            console.warn("Error send failed:", sendErr);
          }
          break;
        }
        console.log(`Trimmed context to ~${estimatedTokens} tokens. Continuing.`);
      }

      let stream;
      try {
        stream = await claude.getStreamedResponse(SYS_PROMPT, history, currentTools);
      } catch (modelError) {
        console.error("Model invocation failed:", modelError);
        try {
          await safeSend({
            ConnectionId: id,
            Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
          });
        } catch (sendErr) {
          console.warn("Error send failed:", sendErr);
        }
        break;
      }

      try {
        let currentIterationText = "";
        let currentIterationCitations = [];
        // Map of content block index -> { id, name, inputJson } for parallel tool calls
        const pendingTools = new Map();

        for await (const event of stream) {
          const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
          const parsedChunk = await claude.parseChunk(chunk);
          if (!parsedChunk) continue;

          // --- Handle stop_reason ---
          if (parsedChunk.stop_reason) {
            if (parsedChunk.stop_reason === "tool_use") {
              // All tool_use blocks and their input deltas have arrived; execute them
              const toolCalls = [...pendingTools.values()];
              toolRoundCount += toolCalls.length;
              if (toolRoundCount > MAX_TOOL_ROUNDS) {
                console.error(`Exceeded MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}). Breaking out of tool loop.`);
                try {
                  await safeSend({
                    ConnectionId: id,
                    Data: "I've reached the maximum number of search iterations for this question. Here's what I found so far based on my research."
                  });
                } catch (statusErr) {
                  console.warn("Status send failed:", statusErr);
                }
                modelResponse = "I've reached the maximum number of search iterations. Please try rephrasing your question or asking something more specific.";
                stopLoop = true;
                break;
              }
              console.log(`tool round: ${toolCalls.length} parallel call(s), cumulative ${toolRoundCount}/${MAX_TOOL_ROUNDS}`);

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
                  console.error(`Failed to parse tool input for ${tc.name} (${tc.id}):`, tc.inputJson, parseError);
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

              // Execute tools sequentially to avoid chunkIndex race on fullDocs.sources
              const toolResults = [];
              for (const tc of toolCalls) {
                const query = tc.parsedInput;
                if (query === null) {
                  toolResults.push({ toolId: tc.id, content: `Error: the input for tool "${tc.name}" could not be parsed as valid JSON. Please retry with a correctly structured JSON object matching the tool's schema.`, documentBlocks: [] });
                  continue;
                }

                if (tc.name === "query_db") {
                  console.log("using knowledge bases!");
                  const statusQuery = truncate(query.query);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: statusQuery
                        ? `!<|STATUS|>!Searching documents for "${statusQuery}"...`
                        : "!<|STATUS|>!Searching documents..."
                    });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
                  }
                  const docResult = await retrieveKBDocs(query.query, knowledgeBase, process.env.KB_ID, fullDocs.sources.length);
                  fullDocs.sources = fullDocs.sources.concat(docResult.sources);
                  for (const src of docResult.sources) {
                    documentIndexMap.push(src);
                  }
                  const text = docResult.documentBlocks.length > 0
                    ? `Retrieved ${docResult.documentBlocks.length} relevant documents. Analyze the attached documents to answer the user's question.`
                    : docResult.content;
                  console.log("correctly used tool: query_db");
                  toolResults.push({ toolId: tc.id, content: text, documentBlocks: docResult.documentBlocks });

                } else if (tc.name === "retrieve_full_document") {
                  console.log(`retrieving full document: ${query.document_name}`);
                  const docNameDisplay = truncate(query.document_name);
                  try {
                    await safeSend({
                      ConnectionId: id, Data: `!<|STATUS|>!Retrieving full document "${docNameDisplay}"...`
                    });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
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
                  console.log("correctly used tool: retrieve_full_document");
                  toolResults.push({ toolId: tc.id, content: text, documentBlocks: fullDocResult.documentBlocks });

                } else if (tc.name === "fetch_metadata") {
                  console.log("fetching metadata!");
                  try {
                    await safeSend({
                      ConnectionId: id, Data: "!<|STATUS|>!Fetching contract metadata..."
                    });
                  } catch (statusErr) {
                    console.warn("Status send failed:", statusErr);
                  }
                  const metadata = await fetchMetadata();
                  console.log("correctly used tool: fetch_metadata");
                  toolResults.push({ toolId: tc.id, content: metadata ? JSON.stringify(metadata) : "No metadata available.", documentBlocks: [] });

                } else if (tc.name === "query_excel_index") {
                  const indexName = query.index_name;
                  const idxMeta = currentIndexes.find(i => i.index_name === indexName);
                  const displayName = idxMeta?.display_name || indexName;
                  const searchTerm = truncate(query.free_text);
                  console.log(`querying excel index: ${indexName}`);
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
                    console.warn("Status send failed:", statusErr);
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
                  console.log("correctly used tool: query_excel_index");
                  toolResults.push({ toolId: tc.id, content: `Excel query results from ${displayName}. Analyze the attached document.`, documentBlocks: [excelDocBlock] });

                } else {
                  console.warn("Unknown tool:", tc.name);
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
                console.warn("Status send failed:", statusErr);
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
                  console.error("Error flushing final answer:", err);
                }
              }
              modelResponse = currentIterationText;
              stopLoop = true;
              break;
            }
            continue;
          }

          // --- Handle content_block_start for tool_use ---
          if (parsedChunk.type === "tool_use") {
            pendingTools.set(parsedChunk.index, {
              id: parsedChunk.id,
              name: parsedChunk.name,
              inputJson: "",
            });
            continue;
          }

          // --- Handle streaming deltas ---
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
        console.error("Stream processing error:", error);
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
          console.error("Non-transient error — not retrying:", error.name, error.message);
          try {
            await safeSend({
              ConnectionId: id,
              Data: "<!ERROR!>: I'm sorry, something went wrong processing your request. Please try again or rephrase your question."
            });
          } catch (sendErr) {
            console.warn("Error send failed:", sendErr);
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
              console.warn("Error send failed:", sendErr);
            }
            stopLoop = true;
          } else {
            console.log(`Transient error — retry ${streamRetries}/${MAX_STREAM_RETRIES}`);
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
      console.error("Failed to persist response trace:", traceError);
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
      console.error("Error sending EOF_STREAM and sources:", e);
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
        console.error("FAQ classification fire-and-forget failed:", classifyErr);
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
        console.error("Title generation failed:", titleError);
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
          console.error("Session save failed:", parsedSave.body);
        }
      } catch (saveParseError) {
        console.error("Failed to parse session save response:", saveParseError);
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
        console.log("Context summary persisted to DynamoDB.");
      } catch (sumErr) {
        console.error("Failed to save context summary:", sumErr);
      }
    }

    if (!connectionGone) {
      try {
        await wsConnectionClient.send(new DeleteConnectionCommand({ ConnectionId: id }));
      } catch (disconnectErr) {
        console.warn("Connection cleanup failed:", disconnectErr);
      }
    }

  } catch (error) {
    console.error("Error:", error);
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
      console.error("Failed to write error trace:", traceErr);
    }
    try {
      await wsConnectionClient.send(new PostToConnectionCommand({
        ConnectionId: id,
        Data: "<!ERROR!>: I'm sorry, something went wrong. Please try again or rephrase your question."
      }));
    } catch (sendErr) {
      console.warn("Final error send failed:", sendErr);
    }
  }
}

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
      console.error("Failed to parse JSON:", err)
    }
    console.log(routeKey);

    switch (routeKey) {
      case '$connect':
        console.log('CONNECT')
        return { statusCode: 200 };
      case '$disconnect':
        console.log('DISCONNECT')
        return { statusCode: 200 };
      case '$default':
        console.log('DEFAULT')
        return { 'action': 'Default Response Triggered' }
      case "getChatbotResponse":
        console.log('GET CHATBOT RESPONSE')
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
