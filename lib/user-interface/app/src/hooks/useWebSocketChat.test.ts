import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import React from "react";
import { useWebSocketChat } from "./useWebSocketChat";
import { AppContext } from "../common/app-context";
import type { AppConfig } from "../common/types";
import type { ChatBotHistoryItem } from "../components/chatbot/types";
import type { StreamingStatus } from "./useWebSocketChat";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../common/utils", () => ({
  Utils: {
    authenticate: vi.fn().mockResolvedValue("mock-token"),
    parseUserIdentity: vi
      .fn()
      .mockReturnValue({ displayName: "Test User", agency: "TestAgency" }),
    delay: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../components/chatbot/utils", () => ({
  assembleHistory: vi.fn().mockReturnValue([]),
}));

class MockWebSocket {
  // Mirror the real WebSocket readyState constants so production code that
  // checks `WebSocket.OPEN` / `WebSocket.CONNECTING` behaves the same here.
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static lastInstance: MockWebSocket | null = null;
  url: string;
  readyState = 0;
  private listeners: Record<string, Function[]> = {};
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
  }

  addEventListener(event: string, handler: Function) {
    this.listeners[event] = [...(this.listeners[event] ?? []), handler];
  }

  send(data: string) {
    this.sent.push(data);
  }

  // Mirrors real WebSocket: fires close event synchronously for test simplicity
  close(code = 1000) {
    this.simulateClose(code);
  }

  simulateOpen() {
    this.readyState = 1;
    this.listeners["open"]?.forEach((h) => h(new Event("open")));
  }

  simulateMessage(data: string) {
    this.listeners["message"]?.forEach((h) =>
      h(new MessageEvent("message", { data }))
    );
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.listeners["close"]?.forEach((h) =>
      h(new CloseEvent("close", { code }))
    );
  }

  simulateError() {
    this.listeners["error"]?.forEach((h) => h(new Event("error")));
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const mockAppConfig: AppConfig = {
  Auth: {
    region: "us-east-1",
    userPoolId: "us-east-1_test",
    userPoolWebClientId: "test-client-id",
    oauth: {
      domain: "test.auth.com",
      scope: ["openid"],
      redirectSignIn: "http://localhost:3000",
      redirectSignOut: "http://localhost:3000",
      responseType: "code",
    },
  },
  httpEndpoint: "https://test.example.com/",
  wsEndpoint: "wss://test.example.com",
  federatedSignInProvider: "",
};

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(AppContext.Provider, { value: mockAppConfig }, children);

interface SendOpts {
  userMessage: string;
  userId: string;
  sessionId: string;
  messageHistory: ChatBotHistoryItem[];
  onStreamChunk: (accumulated: string) => void;
  onStatusChange: (status: StreamingStatus) => void;
  onSources: (sources: Record<string, any>) => void;
  onComplete: (firstMessage: boolean) => void;
  onError: (msg: string) => void;
}

function makeOpts(overrides: Partial<SendOpts> = {}): SendOpts {
  return {
    userMessage: "Hello ABE",
    userId: "user-123",
    sessionId: "session-456",
    messageHistory: [],
    onStreamChunk: vi.fn(),
    onStatusChange: vi.fn(),
    onSources: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWebSocketChat", () => {
  beforeEach(() => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    MockWebSocket.lastInstance = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("connects to the correct WebSocket URL with auth token", async () => {
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });
    const opts = makeOpts();

    await act(async () => {
      await result.current.send(opts);
    });

    const ws = MockWebSocket.lastInstance!;
    expect(ws.url).toBe("wss://test.example.com/?Authorization=mock-token");
  });

  it("sends the message payload after the WebSocket opens", async () => {
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });
    const opts = makeOpts();

    await act(async () => {
      await result.current.send(opts);
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => ws.simulateOpen());

    expect(ws.sent).toHaveLength(1);
    const payload = JSON.parse(ws.sent[0]);
    expect(payload.action).toBe("getChatbotResponse");
    expect(payload.data.userMessage).toBe("Hello ABE");
    expect(payload.data.user_id).toBe("user-123");
    expect(payload.data.session_id).toBe("session-456");
  });

  it("calls onError when a message starts with the error prefix", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    await act(async () => {
      await result.current.send(makeOpts({ onError }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage("<!ERROR!>:Something went wrong");
    });

    expect(onError).toHaveBeenCalledWith("Something went wrong");
  });

  it("calls onStreamChunk with the fully accumulated text on each chunk", async () => {
    const onStreamChunk = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    await act(async () => {
      await result.current.send(makeOpts({ onStreamChunk }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage("Hello ");
      ws.simulateMessage("world");
    });

    expect(onStreamChunk).toHaveBeenCalledWith("Hello ");
    expect(onStreamChunk).toHaveBeenLastCalledWith("Hello world");
  });

  it("calls onComplete after streamed text plus the EOF marker followed by a clean close", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    // messageHistory is empty so firstMessage = true (length < 3)
    await act(async () => {
      await result.current.send(makeOpts({ onComplete }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage("Hello world");
      ws.simulateMessage("!<|EOF_STREAM|>!");
      ws.simulateClose(1000);
    });

    expect(onComplete).toHaveBeenCalledWith(true);
  });

  it("completes via the EOF grace timer even if the server never closes the socket", async () => {
    // Regression: the backend sends EOF + metadata, then keeps the socket open
    // while it does post-response work (title generation, session save). If
    // that work is slow or fails, the close never arrives — the UI must still
    // leave the streaming state instead of hanging on the stop button.
    const onComplete = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.send(makeOpts({ onComplete }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage("Hello world");
      ws.simulateMessage("!<|EOF_STREAM|>!");
      ws.simulateMessage(
        JSON.stringify([{ chunkIndex: 0, title: "Doc", uri: "s3://x/Doc.pdf" }])
      );
    });

    // No close frame from the server. Completion must come from the grace timer.
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(onComplete).toHaveBeenCalledWith(true);
    expect(ws.readyState).toBe(3); // hook closed the socket itself
    vi.useRealTimers();
  });

  it("completes exactly once when EOF, metadata, and a server close all arrive", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.send(makeOpts({ onComplete }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage("Hello world");
      ws.simulateMessage("!<|EOF_STREAM|>!");
      ws.simulateMessage(
        JSON.stringify([{ chunkIndex: 0, title: "Doc", uri: "s3://x/Doc.pdf" }])
      );
      ws.simulateClose(1000);
    });

    // The pending grace timer must be cancelled so it can't double-complete.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("calls onError when EOF arrives with no streamed text (empty Bedrock response)", async () => {
    const onError = vi.fn();
    const onComplete = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    await act(async () => {
      await result.current.send(makeOpts({ onError, onComplete }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateMessage("!<|EOF_STREAM|>!");
    });

    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("wasn't able to generate a response")
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not call onError on the first unexpected close — schedules a reconnect instead", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.send(makeOpts({ onError }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => {
      ws.simulateOpen();
      ws.simulateClose(1006); // abnormal close (network drop), no EOF received
    });

    // onError must not have been called yet — hook should schedule a retry
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not time out while data is actively arriving", async () => {
    // TIMEOUT_MS = 120_000; interval fires every 5_000
    // If a message arrives at t=85s, lastActivity resets to 85s.
    // At t=170s the interval fires again: Date.now()-lastActivity = 85s < 120s → no timeout.
    const onError = vi.fn();
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    vi.useFakeTimers();
    await act(async () => {
      await result.current.send(makeOpts({ onError }));
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => ws.simulateOpen());

    // Advance to just before the timeout would fire (85s)
    await act(async () => {
      vi.advanceTimersByTime(85_000);
    });

    // A message arrives — resets lastActivity to t=85s
    act(() => ws.simulateMessage("Still streaming…"));

    // Advance another 85s (total 170s wall time, but only 85s since last message)
    await act(async () => {
      vi.advanceTimersByTime(85_000);
    });

    expect(onError).not.toHaveBeenCalledWith(
      expect.stringContaining("timed out")
    );
    vi.useRealTimers();
  });

  it("abort() closes the active WebSocket connection", async () => {
    const { result } = renderHook(() => useWebSocketChat(), { wrapper });

    await act(async () => {
      await result.current.send(makeOpts());
    });

    const ws = MockWebSocket.lastInstance!;
    act(() => ws.simulateOpen());

    // Abort mid-stream — readyState should transition to CLOSED (3)
    act(() => result.current.abort());

    expect(ws.readyState).toBe(3);
  });
});
