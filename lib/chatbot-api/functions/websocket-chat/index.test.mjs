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
        ...dataOverride,
      },
    }),
  };
}

beforeEach(() => {
  mockWsSend.mockReset();
  mockWsSend.mockResolvedValue({});
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
