/**
 * AppShell — the shared ABE chrome (dark top header + left nav rail) that wraps
 * every demo so the mockups read as the real product. The `active` nav id
 * changes per demo. Uses the app's real icon library (@mui/icons-material).
 */
import { type ReactNode } from "react";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import HistoryIcon from "@mui/icons-material/History";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import ForumOutlinedIcon from "@mui/icons-material/ForumOutlined";
import InsightsOutlinedIcon from "@mui/icons-material/InsightsOutlined";
import MenuIcon from "@mui/icons-material/Menu";
import AddIcon from "@mui/icons-material/Add";
import { ABE } from "./demo-kit";

export type NavId = "chat" | "sessions" | "data" | "quality" | "feedback" | "metrics";

const NAV: { group: string; items: { id: NavId; label: string; Icon: typeof ChatBubbleOutlineIcon }[] }[] = [
  {
    group: "Chatbot",
    items: [
      { id: "chat", label: "Chat", Icon: ChatBubbleOutlineIcon },
      { id: "sessions", label: "Sessions", Icon: HistoryIcon },
    ],
  },
  {
    group: "Admin",
    items: [
      { id: "data", label: "Data", Icon: StorageOutlinedIcon },
      { id: "quality", label: "Quality Monitoring", Icon: FactCheckOutlinedIcon },
      { id: "feedback", label: "Feedback", Icon: ForumOutlinedIcon },
      { id: "metrics", label: "Analytics", Icon: InsightsOutlinedIcon },
    ],
  },
];

export const SHELL_HEADER_H = 52;
export const SHELL_SIDEBAR_W = 214;

export const SHELL_CSS = `
.abe-app { display:flex; flex-direction:column; height:100%; }
.abe-appheader {
  height:${SHELL_HEADER_H}px; flex-shrink:0; display:flex; align-items:center;
  gap:12px; padding:0 18px; background:${ABE.headerBg}; color:${ABE.headerText};
}
.abe-appheader .menu { opacity:0.8; display:flex; }
.abe-logo {
  width:30px; height:30px; border-radius:8px; background:${ABE.primary};
  color:#fff; display:flex; align-items:center; justify-content:center;
  font-weight:800; font-size:12px; letter-spacing:-0.02em;
  box-shadow:inset 0 0 0 1px rgba(255,255,255,0.12);
}
.abe-wordmark { font-weight:700; font-size:14.5px; letter-spacing:-0.01em; }
.abe-wordmark span { font-weight:400; opacity:0.62; margin-left:7px; font-size:13px; }
.abe-avatar {
  margin-left:auto; width:30px; height:30px; border-radius:50%;
  background:rgba(255,255,255,0.14); color:#fff; display:flex;
  align-items:center; justify-content:center; font-weight:700; font-size:11px;
}
.abe-appbody { flex:1; display:flex; min-height:0; }
.abe-sidebar {
  width:${SHELL_SIDEBAR_W}px; flex-shrink:0; background:${ABE.sidebarBg};
  border-right:1px solid ${ABE.border}; padding:14px 12px; box-sizing:border-box;
  display:flex; flex-direction:column; gap:6px;
}
.abe-newchat {
  display:flex; align-items:center; justify-content:center; gap:7px;
  padding:9px 12px; border-radius:8px; border:1px solid ${ABE.primary};
  color:${ABE.primary}; font-weight:600; font-size:13px; margin-bottom:8px;
}
.abe-navgroup { font-size:10.5px; font-weight:700; letter-spacing:0.06em;
  text-transform:uppercase; color:${ABE.textTertiary}; padding:8px 10px 4px; }
.abe-navitem {
  display:flex; align-items:center; gap:10px; padding:8px 10px;
  border-radius:8px; font-size:13.5px; color:${ABE.textSecondary}; font-weight:500;
}
.abe-navitem.active { background:${ABE.primaryLight}; color:${ABE.primary}; font-weight:600; }
.abe-navitem svg { font-size:18px; }
.abe-appcontent { flex:1; min-width:0; overflow:hidden; background:${ABE.surface};
  padding:22px 26px; box-sizing:border-box; }
`;

export function AppShell({ active, children }: { active: NavId; children: ReactNode }) {
  return (
    <div className="abe-app">
      <style>{SHELL_CSS}</style>
      <div className="abe-appheader">
        <span className="menu"><MenuIcon style={{ fontSize: 20 }} /></span>
        <span className="abe-logo">ABE</span>
        <span className="abe-wordmark">
          Assistive Buyer Engine<span>Mass. OSD</span>
        </span>
        <span className="abe-avatar">EO</span>
      </div>
      <div className="abe-appbody">
        <nav className="abe-sidebar">
          <div className="abe-newchat"><AddIcon style={{ fontSize: 18 }} /> New chat</div>
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="abe-navgroup">{g.group}</div>
              {g.items.map(({ id, label, Icon }) => (
                <div key={id} className={`abe-navitem${id === active ? " active" : ""}`}>
                  <Icon /> {label}
                </div>
              ))}
            </div>
          ))}
        </nav>
        <main className="abe-appcontent">{children}</main>
      </div>
    </div>
  );
}
