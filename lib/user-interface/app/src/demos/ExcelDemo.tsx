/**
 * ExcelDemo — structured contract lookup: a procurement question → agentic tool
 * use (query_excel_index over the DynamoDB Excel index) → streamed answer that
 * resolves to a clean markdown TABLE, visibly different from semantic RAG (which
 * returns prose). The single Excel source carries excel:true so the Sources panel
 * renders the TableChart icon.
 *
 * Mirrors ChatDemo.tsx: single useSteps() counter, one editable TIMINGS array,
 * one view rendered per phase, data-cursor target on the sources toggle. Unlike
 * ChatDemo there is no empty state — the conversation starts with the question
 * already asked.
 */
import { useRef } from "react";
import { AppShell } from "./app-shell";
import { DemoFrame, DemoStyle, MouseCursor, useSteps, useCursor } from "./demo-kit";
import {
  CHAT_CSS,
  HumanBubble,
  AiBubble,
  InputBar,
  type DemoSource,
} from "./chat-kit";

/** ms per step — keep editable. */
export const TIMINGS = [1500, 1700, 1500, 1900, 2200, 3000];
/** card geometry → recorder viewport (computed in registry). */
export const CARD = { width: 1060, bodyHeight: 668 };

// Step map
const S = {
  THINKING: 0, // conversation view, "Thinking…"
  QUERYING: 1, // "Querying the contract index…" (query_excel_index tool call)
  STREAM: 2, // answer streaming (partial)
  DONE: 3, // full answer + table + collapsed sources
  SOURCES: 4, // sources panel expanded (cursor clicks toggle)
  HOLD: 5, // long hold before loop
};

const QUESTION =
  "Which statewide contracts cover office furniture, and who are the awarded vendors?";

const SOURCES: DemoSource[] = [
  { title: "Statewide Contract Index", meta: "FAC category · 3 contracts matched", excel: true },
];

function AnswerFull() {
  return (
    <>
      <p>Three statewide contracts cover office furniture:</p>
      <table className="abe-mdtable">
        <thead>
          <tr>
            <th>Contract</th>
            <th>Category</th>
            <th>Awarded vendors</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>FAC107 — Office &amp; Classroom Furniture</td>
            <td>Furniture</td>
            <td>14 vendors</td>
          </tr>
          <tr>
            <td>FAC110 — Modular Systems Furniture</td>
            <td>Furniture</td>
            <td>9 vendors</td>
          </tr>
          <tr>
            <td>FAC120 — Library &amp; Educational Furniture</td>
            <td>Furniture</td>
            <td>6 vendors</td>
          </tr>
        </tbody>
      </table>
      <p>
        All three are active through FY27. I can list the awarded vendors for any
        specific contract.
      </p>
    </>
  );
}

export default function ExcelDemo() {
  const step = useSteps(TIMINGS);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { pos, clicking } = useCursor(
    step,
    bodyRef,
    {
      [S.SOURCES]: '[data-cursor="sources"]',
    },
    [S.SOURCES]
  );

  const url = "/chatbot/playground/2b7e9c4d";

  return (
    <>
      <DemoStyle css={CHAT_CSS} />
      <DemoFrame url={url} width={CARD.width} bodyHeight={CARD.bodyHeight} bodyRef={bodyRef}>
        <AppShell active="chat">
          <div className="abe-chatcol">
            <div className="abe-chatscroll">
              <div className="abe-chatstack">
                <HumanBubble text={QUESTION} stamp="2:31 PM" />
                {step === S.THINKING && <AiBubble status="Thinking…" />}
                {step === S.QUERYING && <AiBubble status="Querying the contract index…" />}
                {step === S.STREAM && (
                  <AiBubble showCursor>
                    <p>Three statewide contracts cover office furniture:</p>
                  </AiBubble>
                )}
                {step >= S.DONE && (
                  <AiBubble
                    feedback
                    sources={{ count: 1, open: step >= S.SOURCES, items: SOURCES }}
                    sourcesOpen={step >= S.SOURCES}
                  >
                    <AnswerFull />
                  </AiBubble>
                )}
              </div>
            </div>
            <InputBar value="" />
          </div>
        </AppShell>
        <MouseCursor pos={pos} clicking={clicking} />
      </DemoFrame>
    </>
  );
}
