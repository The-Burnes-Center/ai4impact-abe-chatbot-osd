/**
 * DemoGallery — standalone host for the recording-only demo animations.
 *
 * Mounted by main.tsx *before* the Cognito auth gate (AppConfigured), so it runs
 * with NO auth, NO Amplify, NO BrandBanner/footer — just the MUI theme + a white
 * canvas. Routes:
 *   /demo-animation            → human-readable index of links
 *   /demo-animation/<id>       → the single demo (what the recorder loads)
 *
 * It publishes `window.__DEMO__` / `window.__DEMOS__` so scripts/record-demo.mjs
 * can size the viewport and time each recording from the registry.
 */
import { useEffect } from "react";
import { ThemeProvider as MuiThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { buildTheme } from "../common/theme";
import { DEMOS, byId, viewportOf, loopOf } from "./registry";

function parseId(): string | null {
  const m = window.location.pathname.match(/\/demo-animation\/?([\w-]+)?/);
  return m && m[1] ? m[1] : null;
}

export default function DemoGallery() {
  const theme = buildTheme("light");
  const id = parseId();
  const def = id ? byId(id) : null;

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__DEMOS__ = DEMOS.map((d) => ({
      id: d.id,
      file: d.file,
      label: d.label,
      loopMs: loopOf(d),
      viewport: viewportOf(d.card),
    }));
    if (def) {
      w.__DEMO__ = {
        id: def.id,
        file: def.file,
        loopMs: loopOf(def),
        viewport: viewportOf(def.card),
      };
    }
  }, [def]);

  return (
    <MuiThemeProvider theme={theme}>
      <CssBaseline />
      <div className="abe-demo-root">{def ? <def.Comp /> : <Index />}</div>
    </MuiThemeProvider>
  );
}

function Index() {
  return (
    <div style={{ padding: 48, maxWidth: 720, margin: "0 auto", fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22 }}>ABE — demo animations</h1>
      <p style={{ color: "#555D6B" }}>
        Recording-only mockups of key ABE flows. Open one, or run{" "}
        <code>npm run record-demo</code> to capture MP4 / GIF / WebM.
      </p>
      <ul style={{ lineHeight: 2, fontSize: 15 }}>
        {DEMOS.map((d) => (
          <li key={d.id}>
            <a href={`/demo-animation/${d.id}`}>{d.label}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
