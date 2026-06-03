/**
 * ChatDemo — flagship flow: a procurement question → agentic tool use
 * (query_db over the Bedrock Knowledge Base) → streamed answer with [N]
 * citations → expandable Sources panel.
 *
 * Reference implementation for the other demos: single useSteps() counter,
 * one editable TIMINGS array, one view rendered per phase, data-cursor targets.
 */
import { useRef } from "react";
import { AppShell } from "./app-shell";
import { DemoFrame, DemoStyle, MouseCursor, useSteps, useCursor } from "./demo-kit";
import {
  CHAT_CSS,
  ChatEmptyState,
  HumanBubble,
  AiBubble,
  Citation,
  InputBar,
  type DemoSource,
} from "./chat-kit";

/** ms per step — keep editable. */
export const TIMINGS = [1600, 1500, 1300, 1700, 1500, 1500, 1800, 2200, 3000];
/** card geometry → recorder viewport (computed in registry). */
export const CARD = { width: 1060, bodyHeight: 812 };

// Step map
const S = {
  HOVER_PROMPT: 0, // empty state, cursor on a suggested prompt
  TYPED: 1, // prompt populated the input, cursor on Send (click)
  THINKING: 2, // conversation view, "Thinking…"
  SEARCHING: 3, // "Searching the knowledge base…" (query_db)
  STREAM_1: 4, // answer streaming (partial)
  STREAM_2: 5, // answer streaming (more)
  DONE: 6, // full answer + [N] citations + collapsed sources
  SOURCES: 7, // sources panel expanded (cursor clicks toggle)
  HOLD: 8, // long hold before loop
};

const QUESTION = "How do I make a purchase under a Statewide Contract?";

const SOURCES: DemoSource[] = [
  { title: "Statewide Contract User Guide.pdf", meta: "Page 4" },
  { title: "OSD Procurement Handbook 2024.pdf", meta: "Pages 12–14" },
  { title: "COMMBUYS Buyer Reference.pdf", meta: "Page 8" },
];

function AnswerPartial({ stage }: { stage: 1 | 2 }) {
  return (
    <>
      <p>
        To make a purchase under a Statewide Contract, start by confirming the
        contract actually covers what you need.
      </p>
      {stage === 2 && (
        <p>
          Then compare the awarded vendors and request quotes where the contract
          requires it for larger purchases.
        </p>
      )}
    </>
  );
}

function AnswerFull() {
  return (
    <>
      <p>To make a purchase under a Statewide Contract:</p>
      <ul>
        <li>
          <strong>Confirm scope.</strong> Verify the goods or services are covered
          in the Statewide Contract Index <Citation n={1} />.
        </li>
        <li>
          <strong>Compare vendors.</strong> Over $50,000, request quotes from at
          least three awarded vendors <Citation n={2} />.
        </li>
        <li>
          <strong>Release the order.</strong> Create a Release Requisition in
          COMMBUYS referencing the master contract <Citation n={3} />.
        </li>
      </ul>
      <p>Always confirm your spending authority before committing funds.</p>
    </>
  );
}

export default function ChatDemo() {
  const step = useSteps(TIMINGS);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { pos, clicking } = useCursor(
    step,
    bodyRef,
    {
      [S.HOVER_PROMPT]: '[data-cursor="prompt-3"]',
      [S.TYPED]: '[data-cursor="send"]',
      [S.SOURCES]: '[data-cursor="sources"]',
    },
    [S.TYPED, S.SOURCES]
  );

  const isEmptyView = step <= S.TYPED;
  const url =
    step <= S.TYPED ? "/chatbot/playground/new" : "/chatbot/playground/3f9c1a2b";

  return (
    <>
      <DemoStyle css={CHAT_CSS} />
      <DemoFrame url={url} width={CARD.width} bodyHeight={CARD.bodyHeight} bodyRef={bodyRef}>
        <AppShell active="chat">
          <div className="abe-chatcol">
            <div className="abe-chatscroll">
              {isEmptyView ? (
                <ChatEmptyState hotIndex={step === S.HOVER_PROMPT ? 3 : undefined} />
              ) : (
                <div className="abe-chatstack">
                  <HumanBubble text={QUESTION} stamp="2:14 PM" />
                  {step === S.THINKING && <AiBubble status="Thinking…" />}
                  {step === S.SEARCHING && <AiBubble status="Searching the knowledge base…" />}
                  {step === S.STREAM_1 && (
                    <AiBubble showCursor>
                      <AnswerPartial stage={1} />
                    </AiBubble>
                  )}
                  {step === S.STREAM_2 && (
                    <AiBubble showCursor>
                      <AnswerPartial stage={2} />
                    </AiBubble>
                  )}
                  {step >= S.DONE && (
                    <AiBubble
                      feedback
                      sources={{ count: 3, open: step >= S.SOURCES, items: SOURCES }}
                      sourcesOpen={step >= S.SOURCES}
                    >
                      <AnswerFull />
                    </AiBubble>
                  )}
                </div>
              )}
            </div>
            <InputBar
              value={step === S.TYPED ? QUESTION : ""}
              caret={step === S.TYPED}
              focused={step === S.TYPED}
            />
          </div>
        </AppShell>
        <MouseCursor pos={pos} clicking={clicking} />
      </DemoFrame>
    </>
  );
}
