/**
 * chat-kit — ABE chat-surface primitives, shared by the Chat (semantic RAG) and
 * Excel (structured query) demos. CSS is ported verbatim from
 * styles/chat.module.scss; class names + token values match the real app.
 */
import { type ReactNode } from "react";
import SendIcon from "@mui/icons-material/Send";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import MicNoneIcon from "@mui/icons-material/MicNone";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { Spinner } from "./demo-kit";

export const CHAT_CSS = `
.abe-chatcol { display:flex; flex-direction:column; height:100%; max-width:980px;
  margin:0 auto; width:100%; }
/* Conversation is bottom-anchored (newest content pinned above the input, like a
   real chat); the empty state centers itself. Fixed height + overflow hidden. */
.abe-chatscroll { flex:1; min-height:0; overflow:hidden; padding:6px 4px 8px;
  display:flex; flex-direction:column; }
.abe-chatstack { display:flex; flex-direction:column; gap:16px; }

/* ── empty state ── */
.abe-empty { margin:auto 0; display:flex; flex-direction:column; align-items:center;
  justify-content:center; padding:10px 0; text-align:center; }
.abe-empty-avatar { width:56px; height:56px; border-radius:8px;
  background:var(--abe-primaryLight); color:var(--abe-primary);
  display:flex; align-items:center; justify-content:center;
  font-weight:800; font-size:20px; letter-spacing:-0.02em; margin-bottom:18px; }
.abe-empty h2 { margin:0 0 8px; font-size:24px; font-weight:700; color:var(--abe-textPrimary); }
.abe-empty p { margin:0 auto 4px; font-size:14px; color:var(--abe-textSecondary); max-width:420px; line-height:1.5; }
.abe-prompts { display:grid; grid-template-columns:1fr 1fr; gap:12px;
  margin-top:24px; max-width:620px; }
.abe-promptcard { padding:14px 18px; border-radius:12px; border:1px solid var(--abe-border);
  background:var(--abe-surface); font-size:13.5px; line-height:1.5;
  color:var(--abe-textPrimary); text-align:left; transition:all 150ms cubic-bezier(0.4,0,0.2,1); }
.abe-promptcard.hot { border-color:var(--abe-primary); background:var(--abe-primaryLight);
  transform:translateY(-2px); box-shadow:var(--abe-shadow-sm); }

/* ── messages ── */
.abe-humanMessage { display:flex; justify-content:flex-end; width:100%; animation:slideUp 300ms ease-out; }
.abe-humanInner { display:flex; flex-direction:column; align-items:flex-end; max-width:85%; }
.abe-humanBubble { display:inline-block; max-width:100%; padding:10px 16px;
  border-radius:12px 12px 4px 12px; background:var(--abe-chatHumanBg);
  color:var(--abe-chatHumanText); font-size:15px; line-height:1.6; text-align:left;
  white-space:pre-wrap; }
.abe-stamp { display:block; text-align:right; margin-top:5px; color:var(--abe-textSecondary); font-size:12px; }

.abe-aiMessage { display:flex; gap:12px; align-items:flex-start; animation:slideUp 300ms ease-out; }
.abe-aiAvatar { flex-shrink:0; width:32px; height:32px; border-radius:8px;
  display:flex; align-items:center; justify-content:center; font-weight:800;
  font-size:10px; letter-spacing:-0.02em; margin-top:4px;
  background:var(--abe-primaryLight); color:var(--abe-primary); }
.abe-aiContent { flex:1; min-width:0; }
.abe-aiPaper { padding:16px; background:var(--abe-chatAiBg);
  border:1px solid var(--abe-chatAiBorder); border-radius:12px; position:relative; }
.abe-aiPaper p { margin:8px 0; line-height:1.7; font-size:14.5px; }
.abe-aiPaper p:first-of-type { margin-top:0; }
.abe-aiPaper p:last-of-type { margin-bottom:0; }
.abe-aiPaper strong { font-weight:700; }
.abe-aiPaper ul { margin:8px 0; padding-left:22px; line-height:1.7; font-size:14.5px; }
.abe-aiPaper li { margin:4px 0; }
.abe-copybtn { position:absolute; top:10px; right:10px; opacity:0.4; color:var(--abe-textSecondary); }

.abe-statusIndicator { display:flex; align-items:center; gap:8px; padding:4px 0; animation:fadeIn 300ms ease-out; }
.abe-statusIndicator span.txt { color:var(--abe-textSecondary); font-style:italic; font-size:14px; }

.abe-streamCursor { display:inline-block; width:2px; height:1em; background:var(--abe-primary);
  margin-left:2px; vertical-align:text-bottom; animation:blinkCursor 1s step-end infinite; }

/* ── inline citation badge ── */
.abe-citation { display:inline-flex; align-items:center; justify-content:center;
  min-width:18px; height:18px; padding:0 4px; margin:0 1px; border-radius:9px;
  background:var(--abe-primaryLight); color:var(--abe-primary); font-size:11px;
  font-weight:700; line-height:1; vertical-align:super; transition:all 150ms; }
.abe-citation.hot { background:var(--abe-primary); color:#fff; transform:scale(1.12); }

/* ── feedback thumbs ── */
.abe-thumbs { display:flex; align-items:center; margin-top:10px; gap:2px;
  padding-top:8px; border-top:1px solid var(--abe-borderSubtle); }
.abe-thumb { display:inline-flex; align-items:center; gap:5px; padding:5px 8px;
  border-radius:8px; color:var(--abe-textSecondary); font-size:12px; }
.abe-thumb svg { font-size:16px; }

/* ── markdown table (Excel results) ── */
.abe-mdtable { width:100%; border-collapse:collapse; margin-top:12px;
  border:1px solid var(--abe-tableBorder); border-radius:8px; overflow:hidden; font-size:13.5px; }
.abe-mdtable th, .abe-mdtable td { border:1px solid var(--abe-tableBorder); padding:9px 13px; text-align:left; }
.abe-mdtable th { background:var(--abe-tableHeaderBg); font-weight:600; }
.abe-mdtable tr:nth-child(even) td { background:var(--abe-tableStripeBg); }

/* ── sources panel ── */
.abe-srcToggle { display:inline-flex; align-items:center; gap:6px; padding:6px 10px;
  border-radius:8px; border:1px solid var(--abe-borderSubtle); background:transparent;
  color:var(--abe-textSecondary); font-size:13px; margin-top:8px; }
.abe-srcToggle .chev { transition:transform 200ms ease; }
.abe-srcToggle .chev.open { transform:rotate(180deg); }
.abe-srcList { display:flex; flex-direction:column; gap:6px; margin-top:8px;
  overflow:hidden; animation:fadeIn 220ms ease-out; }
.abe-srcRow { display:flex; align-items:center; gap:10px; padding:10px 12px;
  background:var(--abe-surface); border:1px solid var(--abe-borderSubtle);
  border-radius:8px; text-align:left; }
.abe-srcRow .ic { font-size:18px; color:var(--abe-primary); flex-shrink:0; }
.abe-srcRow .body { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.abe-srcRow .title { font-weight:600; font-size:13px; color:var(--abe-textPrimary); }
.abe-srcRow .meta { font-size:12px; color:var(--abe-textSecondary); }
.abe-srcRow .open { font-size:16px; color:var(--abe-textTertiary); flex-shrink:0; }

/* ── input bar ── */
.abe-inputwrap { flex-shrink:0; padding:14px 4px 4px; }
.abe-input { display:flex; align-items:center; gap:8px; padding:8px 8px 8px 16px;
  border-radius:24px; background:var(--abe-surface); border:1px solid var(--abe-border);
  box-shadow:var(--abe-shadow-md); }
.abe-input.focus { border-color:var(--abe-primary); box-shadow:var(--abe-shadow-lg); }
.abe-input .txt { flex:1; font-size:15px; color:var(--abe-textPrimary); line-height:1.6; }
.abe-input .txt.ph { color:var(--abe-textTertiary); }
.abe-mic { color:var(--abe-textSecondary); display:flex; padding:6px; }
.abe-send { display:inline-flex; align-items:center; gap:6px; padding:8px 16px;
  border-radius:16px; background:var(--abe-primary); color:#fff; font-weight:600;
  font-size:14px; border:none; }
.abe-send.disabled { background:var(--abe-border); color:var(--abe-textTertiary); }
.abe-stop { display:inline-flex; align-items:center; justify-content:center; padding:7px;
  border-radius:50%; border:1px solid var(--abe-error); color:var(--abe-error); }
`;

/* ── components ───────────────────────────────────────────────────────────── */

export function AiAvatar() {
  return <div className="abe-aiAvatar">ABE</div>;
}

export function HumanBubble({ text, stamp }: { text: string; stamp?: string }) {
  return (
    <div className="abe-humanMessage">
      <div className="abe-humanInner">
        <div className="abe-humanBubble">{text}</div>
        {stamp && <span className="abe-stamp">{stamp}</span>}
      </div>
    </div>
  );
}

export function Citation({ n, hot }: { n: number; hot?: boolean }) {
  return <span className={`abe-citation${hot ? " hot" : ""}`}>{n}</span>;
}

export type DemoSource = { title: string; meta: string; excel?: boolean };

export function SourcesPanel({
  count,
  open,
  sources,
}: {
  count: number;
  open: boolean;
  sources: DemoSource[];
}) {
  return (
    <div style={{ marginTop: 4 }}>
      <button className="abe-srcToggle" type="button" data-cursor="sources">
        <DescriptionOutlinedIcon style={{ fontSize: 16 }} />
        <span>
          {count} document{count !== 1 ? "s" : ""} referenced
        </span>
        <ExpandMoreIcon className={`chev${open ? " open" : ""}`} style={{ fontSize: 18 }} />
      </button>
      {open && (
        <div className="abe-srcList">
          {sources.map((s, i) => (
            <div className="abe-srcRow" key={i}>
              {s.excel ? (
                <TableChartOutlinedIcon className="ic" />
              ) : (
                <DescriptionOutlinedIcon className="ic" />
              )}
              <div className="body">
                <span className="title">{s.title}</span>
                <span className="meta">{s.meta}</span>
              </div>
              <OpenInNewIcon className="open" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Assistant message bubble. Pass `status` for the thinking/searching state, or
 *  `children` for streamed/finished content. */
export function AiBubble({
  status,
  children,
  showCursor,
  feedback,
  sources,
  sourcesOpen,
}: {
  status?: string;
  children?: ReactNode;
  showCursor?: boolean;
  feedback?: boolean;
  sources?: { count: number; open: boolean; items: DemoSource[] };
  sourcesOpen?: boolean;
}) {
  return (
    <div className="abe-aiMessage">
      <AiAvatar />
      <div className="abe-aiContent">
        <div className="abe-aiPaper">
          {children && (
            <span className="abe-copybtn">
              <ContentCopyIcon style={{ fontSize: 16 }} />
            </span>
          )}
          {status ? (
            <div className="abe-statusIndicator">
              <Spinner size={14} />
              <span className="txt">{status}</span>
            </div>
          ) : null}
          {children}
          {showCursor ? <span className="abe-streamCursor" /> : null}
          {feedback && (
            <div className="abe-thumbs">
              <span className="abe-thumb">
                <ThumbUpOutlinedIcon /> Helpful
              </span>
              <span className="abe-thumb">
                <ThumbDownOutlinedIcon /> Not helpful
              </span>
            </div>
          )}
        </div>
        {sources && (
          <SourcesPanel count={sources.count} open={!!sourcesOpen} sources={sources.items} />
        )}
      </div>
    </div>
  );
}

/** The pinned bottom input. `value` shows typed text; empty shows placeholder. */
export function InputBar({
  value,
  sending,
  caret,
  focused,
}: {
  value: string;
  sending?: boolean;
  caret?: boolean;
  focused?: boolean;
}) {
  const empty = value.length === 0;
  return (
    <div className="abe-inputwrap">
      <div className={`abe-input${focused ? " focus" : ""}`}>
        <span className={`txt${empty ? " ph" : ""}`}>
          {empty ? "Ask ABE a question..." : value}
          {caret && <span className="abe-streamCursor" style={{ height: "1.1em" }} />}
        </span>
        <span className="abe-mic">
          <MicNoneIcon style={{ fontSize: 20 }} />
        </span>
        {sending ? (
          <span className="abe-stop">
            <StopCircleOutlinedIcon style={{ fontSize: 18 }} />
          </span>
        ) : (
          <button className={`abe-send${empty ? " disabled" : ""}`} type="button" data-cursor="send">
            Send <SendIcon style={{ fontSize: 16 }} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Empty-state hero with the 4 real suggested-prompt cards. */
export function ChatEmptyState({ hotIndex }: { hotIndex?: number }) {
  const prompts = [
    "Where do I find a list of Statewide Contracts?",
    "How do I know if my procurement need is within the scope of a Statewide Contract?",
    "How do I know if my procurement qualifies for an exception?",
    "How do I make a purchase under a Statewide Contract?",
  ];
  return (
    <div className="abe-empty">
      <div className="abe-empty-avatar">ABE</div>
      <h2>What can I help you with?</h2>
      <p>Ask me about Massachusetts procurement processes, statewide contracts, bidding, and more.</p>
      <div className="abe-prompts">
        {prompts.map((p, i) => (
          <div
            className={`abe-promptcard${i === hotIndex ? " hot" : ""}`}
            data-cursor={`prompt-${i}`}
            key={i}
          >
            {p}
          </div>
        ))}
      </div>
    </div>
  );
}
