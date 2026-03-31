import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import React from "react";
import ChatInputPanel from "./chat-input-panel";
import { NotificationContext } from "../notif-manager";
import { ChatBotMessageType } from "./types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("react-speech-recognition", () => ({
  default: { startListening: vi.fn(), stopListening: vi.fn() },
  useSpeechRecognition: () => ({
    transcript: "",
    listening: false,
    browserSupportsSpeechRecognition: false,
  }),
}));

vi.mock("../../hooks/useWebSocketChat", () => ({
  useWebSocketChat: () => ({ send: vi.fn(), abort: vi.fn() }),
}));

vi.mock("aws-amplify", () => ({
  Auth: {
    currentAuthenticatedUser: vi.fn().mockResolvedValue({
      username: "test-user",
      signInUserSession: {
        idToken: { payload: { name: "Smith, Jane (OSD)" } },
      },
    }),
  },
}));

vi.mock("../../common/utils", () => ({
  Utils: {
    parseUserIdentity: vi
      .fn()
      .mockReturnValue({ displayName: "Smith, Jane", agency: "OSD" }),
    delay: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const defaultProps = {
  running: false,
  setRunning: vi.fn(),
  session: { id: "session-1", loading: false },
  messageHistory: [],
  setMessageHistory: vi.fn(),
  streamingStatus: { text: "", active: false },
  setStreamingStatus: vi.fn(),
};

function renderWithNotifications(
  ui: React.ReactElement,
  addNotification = vi.fn()
) {
  return render(
    <NotificationContext.Provider
      value={{
        notifications: [],
        addNotification,
        removeNotification: vi.fn(),
      }}
    >
      {ui}
    </NotificationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatInputPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("send button is disabled when the textarea is empty", () => {
    renderWithNotifications(<ChatInputPanel {...defaultProps} />);

    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeDisabled();
  });

  it("shows the stop button (not send) while a response is running", () => {
    renderWithNotifications(
      <ChatInputPanel {...defaultProps} running={true} />
    );

    expect(
      screen.queryByRole("button", { name: /send message/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /stop generating/i })
    ).toBeInTheDocument();
  });

  it("shows an error notification when Enter is pressed with an empty textarea", async () => {
    const addNotification = vi.fn();
    renderWithNotifications(
      <ChatInputPanel {...defaultProps} />,
      addNotification
    );

    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(addNotification).toHaveBeenCalledWith(
        "error",
        "Please do not submit blank text!"
      );
    });
  });
});
