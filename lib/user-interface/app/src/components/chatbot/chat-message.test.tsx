import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import React from "react";
import ChatMessage from "./chat-message";
import { NotificationContext } from "../notif-manager";
import { ChatBotMessageType } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAiMessage(content: string, sources: any[] = []) {
  return {
    type: ChatBotMessageType.AI,
    content,
    metadata: { Sources: sources },
  };
}

function makeHumanMessage(content: string) {
  return {
    type: ChatBotMessageType.Human,
    content,
    metadata: {},
  };
}

interface Source {
  chunkIndex: number;
  title: string;
  uri: string | null;
  excerpt: string;
  score: number;
  page: number | null;
  s3Key: string | null;
  sourceType: "knowledgeBase";
  cited: boolean;
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    chunkIndex: 1,
    title: "Test Document",
    uri: null,
    excerpt: "Some excerpt text.",
    score: 0.9,
    page: null,
    s3Key: null,
    sourceType: "knowledgeBase",
    cited: true,
    ...overrides,
  };
}

const noop = vi.fn();

function renderMessage(message: ReturnType<typeof makeAiMessage | typeof makeHumanMessage>) {
  return render(
    <NotificationContext.Provider
      value={{
        notifications: [],
        addNotification: vi.fn(),
        removeNotification: vi.fn(),
      }}
    >
      <ChatMessage
        message={message}
        onThumbsUp={noop}
        onSubmitFeedback={noop}
      />
    </NotificationContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatMessage", () => {
  it("renders AI message markdown content", () => {
    renderMessage(makeAiMessage("**Procurement** is handled by OSD."));

    // Role="article" with aria-label="ABE response" wraps AI messages
    const article = screen.getByRole("article", { name: /abe response/i });
    expect(article).toBeInTheDocument();
    // ReactMarkdown renders **text** as <strong>
    expect(article.querySelector("strong")).toHaveTextContent("Procurement");
  });

  it("renders citation badge for a [N] reference that matches a source", () => {
    const source = makeSource({ chunkIndex: 1, title: "Policy Doc" });
    const message = makeAiMessage("See the guidelines [1] for details.", [source]);

    renderMessage(message);

    // CitationBadge renders as a button with aria-label "Source N: Title"
    const badge = screen.getByRole("button", { name: /source 1: policy doc/i });
    expect(badge).toBeInTheDocument();
  });

  it("renders the sources toggle showing the correct document count", () => {
    const sources = [
      makeSource({ chunkIndex: 1, title: "Doc A", cited: true }),
      makeSource({ chunkIndex: 2, title: "Doc B", cited: true }),
    ];
    const message = makeAiMessage("Answer based on [1] and [2].", sources);

    renderMessage(message);

    // Sources toggle shows "{N} document(s) referenced"
    expect(screen.getByText(/2 documents referenced/i)).toBeInTheDocument();
  });

  it("renders a human message with the user's text", () => {
    renderMessage(makeHumanMessage("What vendors are on statewide contract?"));

    expect(
      screen.getByRole("article", { name: /your message/i })
    ).toHaveTextContent("What vendors are on statewide contract?");
  });
});
