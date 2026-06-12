import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mocks so they're available inside vi.mock() factories
const mockWsSend = vi.hoisted(() => vi.fn());
const mockDdbSend = vi.hoisted(() => vi.fn());
const mockLambdaSend = vi.hoisted(() => vi.fn());

// Mock the WebSocket client — the only AWS client touched by validation-path code.
// vitest 4 requires constructor mocks (clients + commands, all `new`-ed in
// index.mjs) to be `function`/`class`, not arrows.
vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: vi.fn(function () { return { send: mockWsSend }; }),
  PostToConnectionCommand: vi.fn(function (input) { return input; }),   // returns input so Data is accessible
  DeleteConnectionCommand:  vi.fn(function (input) { return input; }),
}));

// Stub remaining AWS SDK clients to avoid any accidental network calls
vi.mock("@aws-sdk/client-bedrock-agent-runtime", () => ({
  BedrockAgentRuntimeClient: vi.fn(function () { return { send: vi.fn() }; }),
}));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient:  vi.fn(function () { return { send: mockDdbSend }; }),
  PutItemCommand:  vi.fn(function (i) { return { ...i, __cmd: "PutItem" }; }),
  GetItemCommand:  vi.fn(function (i) { return { ...i, __cmd: "GetItem" }; }),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient:   vi.fn(function () { return { send: mockLambdaSend }; }),
  InvokeCommand:  vi.fn(function (i) { return i; }),
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
function makeEvent(dataOverride = {}, opts = {}) {
  const cognitoUsername = opts.cognito_username === undefined ? "user1" : opts.cognito_username;
  const authorizer = cognitoUsername === null ? {} : { cognito_username: cognitoUsername };
  return {
    requestContext: {
      connectionId: CONN_ID,
      routeKey: "getChatbotResponse",
      authorizer,
    },
    body: JSON.stringify({
      data: {
        userMessage: "Hello",
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
  ClaudeModel.mockImplementation(function () { return mockInstance; });
  return mockInstance;
}

beforeEach(() => {
  // Reset all mocks (call counts, implementations, etc.)
  vi.clearAllMocks();

  mockWsSend.mockResolvedValue({});
  mockDdbSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});

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

  it("sends error when the authorizer did not attach a user identifier", async () => {
    // No JWT-verified identifier → connection should be rejected, regardless
    // of what the client tries to put in data.user_id.
    await handler(makeEvent({}, { cognito_username: null }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("Unauthorized");
  });

  it("sends error when session_id is missing", async () => {
    await handler(makeEvent({ session_id: undefined }));
    expect(mockWsSend).toHaveBeenCalledTimes(1);
    expect(mockWsSend.mock.calls[0][0].Data).toContain("Missing session_id");
  });

  it("ignores a client-supplied user_id in favor of the authorizer principal", async () => {
    // A client trying to impersonate another user by passing a different
    // user_id in the body must not be able to. We assert the request
    // proceeds past validation (no error from the user-id check) using the
    // authorizer principal — KB_ID is set so the next code path runs.
    await handler(makeEvent({ user_id: "victim-user" }));
    const idError = mockWsSend.mock.calls.find(call => call[0].Data?.includes("Unauthorized"));
    expect(idError).toBeUndefined();
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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

    await handler(makeEvent());

    expect(retrieveKBDocs).toHaveBeenCalledWith(
      "vendor list",
      expect.anything(),
      "test-kb-id",
      expect.any(Number),
      { withinDocument: null }
    );
  });

  it("forwards within_document from the query_db input to retrieveKBDocs", async () => {
    let callCount = 0;
    const mockInstance = {
      assembleHistory: vi.fn((_hist, prompt) => [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ]),
      getStreamedResponse: vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return buildStream([
            makeStreamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1b", name: "query_db" } }),
            makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"pricing terms","within_document":"FAC115"}' } }),
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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

    await handler(makeEvent());

    expect(retrieveKBDocs).toHaveBeenCalledWith(
      "pricing terms",
      expect.anything(),
      "test-kb-id",
      expect.any(Number),
      { withinDocument: "FAC115" }
    );
    // Status frame reflects the document scoping
    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.includes('Searching "FAC115" for "pricing terms"'))).toBe(true);
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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

    await handler(makeEvent());

    // After MAX_STREAM_RETRIES (3) attempts, it should send an error
    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d => typeof d === "string" && d.includes("<!ERROR!>"))).toBe(true);
    // Model was invoked multiple times (initial + retries)
    expect(mockInstance.getStreamedResponse.mock.calls.length).toBeGreaterThan(1);
  });

  it("exits the loop silently when MAX_TOOL_ROUNDS is exceeded (no user-facing 'iteration' message)", async () => {
    // Force a tiny limit so we don't have to drive the default (200) iterations.
    process.env.MAX_TOOL_ROUNDS = "3";

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

    try {
      await handler(makeEvent());

      const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
      // The user must NEVER see an "iteration"/"maximum" message — bad UX.
      // (The whole point of this change is that the cap is silent.)
      expect(
        sentData.some(d => typeof d === "string" && /maximum|iteration/i.test(d))
      ).toBe(false);
      // EOF marker was sent so the client knows the turn is over (i.e. the
      // loop terminated cleanly rather than hanging).
      expect(sentData).toContain("!<|EOF_STREAM|>!");
      // The model was invoked exactly MAX_TOOL_ROUNDS + 1 times: the +1 is
      // the iteration on which the cap fires before tool execution.
      expect(mockInstance.getStreamedResponse.mock.calls.length).toBe(4);
    } finally {
      delete process.env.MAX_TOOL_ROUNDS;
    }
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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

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
    ClaudeModel.mockImplementation(function () { return mockInstance; });

    await handler(makeEvent());

    const sentData = mockWsSend.mock.calls.map(c => c[0].Data);
    expect(sentData.some(d =>
      typeof d === "string" && d.startsWith("!<|STATUS|>!") && d.includes("FAC115.pdf")
    )).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Disconnect classification — deliberate stop vs. silent network drop
// ---------------------------------------------------------------------------

describe("disconnect classification (stop vs network drop)", () => {
  const goneError = () => {
    const err = new Error("Gone");
    err.name = "GoneException";
    return err;
  };

  /** Marker GetItem lookups are keyed WSDISCONNECT#<connectionId>. */
  const isMarkerLookup = (cmd) =>
    cmd?.__cmd === "GetItem" && cmd?.Key?.MessageId?.S?.startsWith("WSDISCONNECT#");

  beforeEach(() => {
    process.env.RESPONSE_TRACE_TABLE = "trace-table";
    process.env.SESSION_HANDLER = "session-fn";
    // Skip the real 2s polling delays between marker checks
    process.env.STOP_MARKER_POLL_MS = "0";
  });

  function sessionSaveCalls() {
    return mockLambdaSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?.FunctionName === "session-fn")
      .map((cmd) => JSON.parse(JSON.parse(cmd.Payload).body))
      .filter((body) => body.operation === "append_chat_entry");
  }

  it("network drop (no $disconnect marker): finishes the answer and saves it", async () => {
    // Every WebSocket send fails: APIGW considers the connection gone
    mockWsSend.mockRejectedValue(goneError());
    // No clean-disconnect marker exists -> classified as network drop
    mockDdbSend.mockImplementation(async (cmd) =>
      isMarkerLookup(cmd) ? {} : {});

    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer for a dropped client" } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    // The exchange is saved so a reload shows the full answer
    const saves = sessionSaveCalls();
    expect(saves).toHaveLength(1);
    expect(saves[0].new_chat_entry.chatbot).toContain("Answer for a dropped client");

    // The response trace is written too
    const traceWrites = mockDdbSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?.__cmd === "PutItem" && cmd?.Item?.FinalAnswer);
    expect(traceWrites).toHaveLength(1);
    expect(traceWrites[0].Item.FinalAnswer.S).toContain("Answer for a dropped client");
  });

  it("deliberate stop ($disconnect marker present): discards and skips save", async () => {
    mockWsSend.mockRejectedValue(goneError());
    // Clean-disconnect marker exists -> classified as deliberate stop
    mockDdbSend.mockImplementation(async (cmd) =>
      isMarkerLookup(cmd) ? { Item: { MessageId: { S: "WSDISCONNECT#test-conn" } } } : {});

    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer nobody wants" } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    expect(sessionSaveCalls()).toHaveLength(0);
    const traceWrites = mockDdbSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?.__cmd === "PutItem" && cmd?.Item?.FinalAnswer);
    expect(traceWrites).toHaveLength(0);
  });

  it("$disconnect route writes a clean-close marker for the connection", async () => {
    await handler({
      requestContext: { connectionId: "conn-abc", routeKey: "$disconnect" },
    });

    const markerWrites = mockDdbSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?.__cmd === "PutItem" && cmd?.Item?.MessageId?.S === "WSDISCONNECT#conn-abc");
    expect(markerWrites).toHaveLength(1);
    // TTL attribute present so the table's TTL cleans the marker up
    expect(markerWrites[0].Item.expiresAt?.N).toBeTruthy();
  });

  it("healthy connection: no marker lookups are made", async () => {
    setupClaudeModel([
      makeStreamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "All good" } }),
      makeStreamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
    ]);

    await handler(makeEvent());

    expect(mockDdbSend.mock.calls.map((c) => c[0]).filter(isMarkerLookup)).toHaveLength(0);
  });
});
