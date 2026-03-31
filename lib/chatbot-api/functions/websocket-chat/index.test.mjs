import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock so it's available inside vi.mock() factories
const mockWsSend = vi.hoisted(() => vi.fn());

// Mock the WebSocket client — the only AWS client touched by validation-path code
vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: vi.fn(() => ({ send: mockWsSend })),
  PostToConnectionCommand: vi.fn(input => input),   // returns input so Data is accessible
  DeleteConnectionCommand:  vi.fn(input => input),
}));

// Stub remaining AWS SDK clients to avoid any accidental network calls
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: vi.fn(() => ({ send: vi.fn() })),
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient:  vi.fn(() => ({ send: vi.fn() })),
  PutItemCommand:  vi.fn(i => i),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient:   vi.fn(() => ({ send: vi.fn() })),
  InvokeCommand:  vi.fn(i => i),
}));

// Stub internal modules that make network calls
vi.mock("./kb.mjs", () => ({
  retrieveKBDocs:       vi.fn(),
  retrieveFullDocument: vi.fn(),
}));
vi.mock("./tools.mjs", () => ({
  STATIC_TOOLS:                       [],
  truncate:                            vi.fn(s => s),
  capToolResultSize:                   vi.fn(s => s),
  getAllTools:                          vi.fn(() => Promise.resolve({ tools: [], indexes: [] })),
  fetchMetadata:                       vi.fn(),
  enrichExcelIndexResult:              vi.fn((_q, _n, s) => s),
  invokeIndexQuery:                    vi.fn(),
  constructSysPrompt:                  vi.fn(() => Promise.resolve({
    metadata: {},
    promptVersionId: "test",
    promptTemplateHash: "abc",
    promptText: "test prompt",
  })),
}));
vi.mock("./citations.mjs", () => ({
  insertCitationMarkers:        vi.fn(t => t),
  validateSelfManagedCitations: vi.fn(t => t),
  renumberCitations:            vi.fn((t, s) => ({ text: t, sources: s ?? [] })),
}));
vi.mock("./models/chat-model.mjs", () => ({ default: vi.fn() }));

import { handler } from "./index.mjs";
import ClaudeModel from "./models/chat-model.mjs";
import { retrieveKBDocs, retrieveFullDocument } from "./kb.mjs";
import { fetchMetadata, invokeIndexQuery } from "./tools.mjs";
import {
  insertCitationMarkers,
  validateSelfManagedCitations,
  renumberCitations,
} from "./citations.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONN_ID = "test-conn";
const MAX_LEN = 10_000;

/** Build a valid getChatbotResponse event, with optional overrides in `data`. */
function makeEvent(dataOverride = {}) {
  return {
    requestContext: { connectionId: CONN_ID, routeKey: "getChatbotResponse" },
    body: JSON.stringify({
      data: {
        userMessage: "Hello",
        user_id:     "user1",
        session_id:  "sess1",
        chatHistory: [],
        ...dataOverride,
      },
    }),
  };
}

/**
 * Build a minimal async generator that yields Bedrock-style stream events,
 * followed by a stop event.
 *
 * Each event is shaped like { chunk: { bytes: Uint8Array(JSON) } }.
 */
function makeStreamEvent(chunkObj) {
  const bytes = new TextEncoder().encode(JSON.stringify(chunkObj));
  return { chunk: { bytes } };
}

/** Build a stream that yields the provided events in order. */
async function* buildStream(events) {
  for (const ev of events) {
    yield ev;
  }
}

/**
 * Minimal parseChunk implementation matching chat-model.mjs.
 * Converts Bedrock streaming event objects to the kinds that index.mjs
 * inspects (text, tool_input, citation, tool_use, stop_reason).
 */
function parseChunk(chunk) {
  if (chunk.type === "content_block_delta") {
    const idx = chunk.index;
    if (chunk.delta.type === "text_delta") {
      return { kind: "text", text: chunk.delta.text, index: idx };
    }
    if (chunk.delta.type === "input_json_delta") {
      return { kind: "tool_input", json: chunk.delta.partial_json, index: idx };
    }
    if (chunk.delta.type === "citations_delta") {
      return { kind: "citation", citation: chunk.delta.citation, index: idx };
    }
  } else if (chunk.type === "content_block_start") {
    if (chunk.content_block.type === "tool_use") {
      return { ...chunk.content_block, index: chunk.index };
    }
  } else if (chunk.type === "message_delta") {
    return chunk.delta;
  }
  return null;
}

/**
 * Set up ClaudeModel mock for a single agentic turn.
 * - assembleHistory returns a predictable history array
 * - parseChunk uses the real logic to convert stream events
 * - getStreamedResponse returns the provided async iterable
 */
function setupClaudeModel(streamEvents) {
  const mockInstance = {
    assembleHistory: vi.fn((_hist, prompt) => [
      { role: "user", content: [{ type: "text", text: prompt }] },
    ]),
    parseChunk: vi.fn(parseChunk),
    getStreamedResponse: vi.fn(() => buildStream(streamEvents)),
    modelId: "test-model",
  };
  ClaudeModel.mockImplementation(() => mockInstance);
  return mockInstance;
}

beforeEach(() => {
  // Reset all mocks (call counts, implementations, etc.)
  vi.clearAllMocks();

  mockWsSend.mockResolvedValue({});

  // By default, set KB_ID so the handler doesn't bail out early
  process.env.KB_ID = "test-kb-id";

  // Reset citation mocks to passthrough defaults
  insertCitationMarkers.mockImplementation(t => t);
  validateSelfManagedCitations.mockImplementation(t => t);
  renumberCitations.mockImplementation((t, s) => ({ text: t, sources: s ?? [] }));

  // Default: KB returns empty results; tools return empty query results
  retrieveKBDocs.mockResolvedValue({ content: "", sources: [], documentBlocks: [] });
  retrieveFullDocument.mockResolvedValue({ content: "", sources: [], documentBlocks: [] });
  fetchMetadata.mockResolvedValue(null);
  invokeIndexQuery.mockResolvedValue(JSON.stringify({ total_matches: 0, returned: 0, rows: [] }));
});

// ---------------------------------------------------------------------------
// Route handling
// ---------------------------------------------------------------------------

describe("handler route handling", () => {
  it("returns 200 for $connect without sending WebSocket messages", async () => {
    const result = await handler({
      requestContext: { routeKey: "$connect", connectionId: CONN_ID },
    });
    expect(result.statusCode).toBe(200);
    expect(mockWsSend).not.toHaveBeenCalled();
  });

  it("returns 200 for $disconnect without sending WebSocket messages", async () => {
    const result = await handler({
      requestContext: { routeKey: "$disconnect", connectionId: CONN_ID },
    });
    expect(result.statusCode).toBe(200);
    expect(mockWsSend).not.toHaveBeenCalled();
  });

  it("returns 404 for an unrecognised route", async () => {
    const result = await handler({
      requestContext: { routeKey: "unknownRoute", connectionId: CONN_ID },
    });
    expect(result.statusCode).toBe(404);
  });

  it("returns a default response for $default route", async () => {
    const result = await handler({
      requestContext: { routeKey: "$default", connectionId: CONN_ID },
    });
    expect(result).toHaveProperty("action");
  });
});

// ---------------------------------------------------------------------------
// Input validation (via getChatbotResponse route)
// ---------------------------------------------------------------------------

describe("getUserResponse input validation", () => {
  it("sends error when request body has no data field", async () => {
    await handler({
      requestContext: { connectionId: CONN_ID, routeKey: "getChatbotResponse" },
      body: "{}",
    });
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("Invalid request format");
  });

  it("sends error for blank userMessage (whitespace only)", async () => {
    await handler(makeEvent({ userMessage: "   " }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("non-empty string");
  });

  it("sends error when userMessage is not a string", async () => {
    await handler(makeEvent({ userMessage: 42 }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("non-empty string");
  });

  it("sends error when userMessage is null", async () => {
    await handler(makeEvent({ userMessage: null }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("non-empty string");
  });

  it("sends error when message exceeds 10,000 characters", async () => {
    await handler(makeEvent({ userMessage: "x".repeat(MAX_LEN + 1) }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("10,000");
  });

  it("does not reject a message of exactly 10,000 characters (proceeds past validation)", async () => {
    // A 10k-char message is valid — getUserResponse continues past validation.
    // It will error later (missing KB_ID env) but must NOT send the length-limit error.
    await handler(makeEvent({ userMessage: "x".repeat(MAX_LEN) }));
    const lengthError = mockWsSend.mock.calls.find(
      call => call[0].Data?.includes("10,000")
    );
    expect(lengthError).toBeUndefined();
  });

  it("sends error when user_id is missing", async () => {
    // JSON.stringify drops undefined keys, so user_id won't appear in the body
    await handler(makeEvent({ user_id: undefined }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("Missing user_id or session_id");
  });

  it("sends error when session_id is missing", async () => {
    await handler(makeEvent({ session_id: undefined }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("Missing user_id or session_id");
  });

  it("sends error when user_id is an empty string", async () => {
    await handler(makeEvent({ user_id: "" }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("Missing user_id or session_id");
  });
});

// ---------------------------------------------------------------------------
// Agentic loop — end_turn (happy path)
// ---------------------------------------------------------------------------

describe("agentic loop — end_turn response", () => {
  it("sends the model text and EOF after a clean end_turn", async () => {
    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from ABE" } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData).toContain("!<|EOF_STREAM|>!");
    // The model text is sent as the final answer
    expect(sentData.some(d => typeof d === "string" && d.includes("Hello from ABE"))).toBe(true);
  });

  it("assembles multiple text delta chunks into a single final message", async () => {
    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Part one " } }),
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "part two" } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.includes("Part one part two"))).toBe(true);
  });

  it("calls renumberCitations on the final text before sending", async () => {
    renumberCitations.mockImplementation((t, s) => ({ text: "[RENUMBERED]" + t, sources: s ?? [] }));

    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer [1]" } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.includes("[RENUMBERED]"))).toBe(true);
  });

  it("calls validateSelfManagedCitations when sources exist but no native citations", async () => {
    // Arrange: KB returns one source
    retrieveKBDocs.mockResolvedValue({
      content: "",
      sources: [{ chunkIndex: 1, title: "doc.pdf", uri: "s3://...", excerpt: "text", score: 0.9, page: 1, s3Key: "key", sourceType: "knowledgeBase" }],
      documentBlocks: [],
    });

    // Two-turn stream: first turn triggers query_db, second produces the answer
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          // Tool use turn
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool1", name: "query_db" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        // Final answer turn
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The answer is here [1]" } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    expect(validateSelfManagedCitations).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Agentic loop — tool dispatch
// ---------------------------------------------------------------------------

describe("agentic loop — tool dispatch", () => {
  it("calls retrieveKBDocs when the model invokes query_db", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "query_db" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"vendor list"}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    expect(retrieveKBDocs).toHaveBeenCalledWith(
      "vendor list",
      expect.anything(),
      "test-kb-id",
      expect.any(Number)
    );
  });

  it("calls retrieveFullDocument when the model invokes retrieve_full_document", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t2", name: "retrieve_full_document" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"document_name":"FAC115.pdf","query_context":"contract terms"}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is the document." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    expect(retrieveFullDocument).toHaveBeenCalledWith(
      "FAC115.pdf",
      expect.anything(),
      "test-kb-id",
      "contract terms",
      expect.any(Number)
    );
  });

  it("calls fetchMetadata when the model invokes fetch_metadata", async () => {
    fetchMetadata.mockResolvedValue({ doc1: "summary" });

    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t3", name: "fetch_metadata" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Metadata retrieved." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    expect(fetchMetadata).toHaveBeenCalled();
  });

  it("calls invokeIndexQuery when the model invokes query_excel_index", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t4", name: "query_excel_index" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"index_name":"STATEWIDE","free_text":"HVAC"}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Excel results." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    expect(invokeIndexQuery).toHaveBeenCalledWith(
      expect.objectContaining({ index_name: "STATEWIDE", free_text: "HVAC" })
    );
  });

  it("returns an error message for an unknown tool name", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t5", name: "totally_unknown_tool" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fallback answer." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    // Should not throw — the unknown tool falls through to a fallback tool_result
    await expect(handler(makeEvent())).resolves.not.toThrow();

    // The handler must still send EOF so the client doesn't hang
    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData).toContain("!<|EOF_STREAM|>!");
  });

  it("sends tool_result error when tool JSON input cannot be parsed", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t6", name: "query_db" } }),
            // Deliberately malformed JSON
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "NOT_JSON{{" } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Recovered." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    // Handler should still produce an EOF — it doesn't crash on bad tool JSON
    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData).toContain("!<|EOF_STREAM|>!");
  });
});

// ---------------------------------------------------------------------------
// Agentic loop — error handling
// ---------------------------------------------------------------------------

describe("agentic loop — error handling", () => {
  it("sends an error message to the client when model invocation throws", async () => {
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn().mockRejectedValue(new Error("Bedrock unavailable")),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.includes("<!ERROR!>"))).toBe(true);
  });

  it("stops the loop after a non-transient stream error and sends error to client", async () => {
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() =>
        // Return an async generator that throws a non-transient error mid-stream
        (async function* () {
          yield makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Start..." } });
          const err = new Error("Unexpected content");
          err.name = "ValidationException";
          throw err;
        })()
      ),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    // Should send an error message, not EOF
    expect(sentData.some(d => typeof d === "string" && d.includes("<!ERROR!>"))).toBe(true);
  });

  it("retries on a ThrottlingException (transient) and eventually sends error after max retries", async () => {
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() =>
        (async function* () {
          const err = new Error("Rate limit exceeded");
          err.name = "ThrottlingException";
          throw err;
        })()
      ),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    // After MAX_STREAM_RETRIES (3) attempts, it should send an error
    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.includes("<!ERROR!>"))).toBe(true);
    // Model was invoked multiple times (initial + retries)
    expect(mockInstance.getStreamedResponse.mock.calls.length).toBeGreaterThan(1);
  });

  it("sends an error when MAX_TOOL_ROUNDS is exceeded", async () => {
    // Each call returns a tool_use so the loop keeps calling tools until limit
    let streamCallCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        streamCallCount++;
        // Always return a tool_use — never an end_turn
        return buildStream([
          makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `t${streamCallCount}`, name: "query_db" } }),
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"test"}' } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    // Should have sent the max-rounds warning message
    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(
      sentData.some(d => typeof d === "string" && d.toLowerCase().includes("maximum"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Agentic loop — citation processing
// ---------------------------------------------------------------------------

describe("agentic loop — citation processing", () => {
  it("calls insertCitationMarkers when native citations arrive in the stream", async () => {
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => buildStream([
        makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The contract ends in December." } }),
        makeStreamEvent({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "citations_delta",
            citation: { document_index: 0, cited_text: "December", start_char_index: 21, end_char_index: 29 },
          },
        }),
        makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      ])),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    expect(insertCitationMarkers).toHaveBeenCalled();
  });

  it("does not call insertCitationMarkers when no citations arrive", async () => {
    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Plain text answer." } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    expect(insertCitationMarkers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Agentic loop — status messages
// ---------------------------------------------------------------------------

describe("agentic loop — status messages", () => {
  it("sends a status message before executing query_db", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "s1", name: "query_db" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"HVAC vendors"}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.startsWith("!<|STATUS|>!"))).toBe(true);
  });

  it("sends a status message before executing retrieve_full_document", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "s2", name: "retrieve_full_document" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"document_name":"FAC115.pdf"}' } }),
            makeStreamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
          ]);
        }
        return buildStream([
          makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
          makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
        ]);
      }),
      parseChunk: vi.fn(parseChunk),
      modelId: "test-model",
    };
    ClaudeModel.mockImplementation(() => mockInstance);

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d =>
      typeof d === "string" && d.startsWith("!<|STATUS|>!") && d.includes("FAC115.pdf")
    )).toBe(true);
  });
});
