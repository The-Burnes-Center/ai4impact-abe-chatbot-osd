# Full-app frontend UX and accessibility audit

**Scope:** `lib/user-interface/app/src` (React 18 + Vite + MUI).  
**Method:** Static code review against UX heuristics, WCAG 2.1 AA-oriented checks, and project hygiene rules. **Axe / manual keyboard / screen reader** passes are documented as **recommended verification** (not run in CI for this document).  
**Last updated:** 2026-03-22

---

## 1. Route inventory and auth (for axe timing)

| Route | Shell | Auth expectations | Notes for automated testing |
|-------|--------|-------------------|----------------------------|
| `/`, `/about`, `/get-started` | None | Often pre-login marketing; app may redirect via Amplify | Run axe logged out and logged in |
| `/chatbot/playground/:sessionId` | BaseAppLayout | Cognito session for API/WebSocket | Primary chat surface |
| `/chatbot/sessions` | BaseAppLayout | Same | List/history |
| `/admin/data` | BaseAppLayout | **AdminPageLayout** — non-admin sees error Alert | Requires admin role |
| `/admin/user-feedback`, `.../:feedbackId` | BaseAppLayout | Admin | See [feedback-ops/ACCESSIBILITY.md](../src/pages/admin/feedback-ops/ACCESSIBILITY.md) |
| `/admin/metrics` | BaseAppLayout | Admin | Charts + tables |
| `/admin/llm-evaluation`, `#dashboard` etc. | BaseAppLayout | Admin | Hash-based tabs |
| `/admin/llm-evaluation/:evaluationId`, `details/:id` | BaseAppLayout | Admin | Detailed eval tables |
| `/help` | BaseAppLayout | Typically authenticated shell | Tabs: tips / about / support |
| `*` (catch-all) | — | Redirects to **new** `/chatbot/playground/<uuid>` | See §8 |

**Admin nav** ([`navigation-panel.tsx`](../src/components/navigation-panel.tsx)): links shown only when Cognito `custom:role` includes `Admin` or `Master Admin`.

---

## 2. Cross-cutting: shell, header, notifications

### Strengths

- **Skip link** + `#main-content` with `tabIndex={-1}` in [`base-app-layout.tsx`](../src/components/base-app-layout.tsx).
- **Landmarks:** `main`, header `role="banner"`, nav `role="navigation"` `aria-label="Main navigation"`.
- **Global header:** IconButtons include `aria-label`; account menu `aria-haspopup`; theme toggle labels.
- **Notifications:** [`notif-flashbar.tsx`](../src/components/notif-flashbar.tsx) uses per-alert `role` and `aria-live` (assertive for errors).

### Findings

| ID | Severity | Type | Location | Issue | Suggestion |
|----|----------|------|----------|-------|------------|
| C1 | P2 | UX | [`global-header.tsx`](../src/components/global-header.tsx) | Brand control calls `navigate("/chatbot/playground")` but route is `playground/:sessionId`. Unmatched path falls through to **catch-all**, which creates a **new** session. Works but URL transition is indirect and confusing. | Navigate to `/chatbot/playground/${uuidv4()}` (or match router convention explicitly). |
| C2 | P2 | UX | [`navigation-panel.tsx`](../src/components/navigation-panel.tsx) | Admin `ListItemButton` `selected={location.pathname === link.href}` — **false** for nested routes (e.g. `/admin/user-feedback/abc` vs `/admin/user-feedback`). Current section not highlighted in nav. | Use `pathname === href \|\| pathname.startsWith(href + "/")` (with exceptions if needed). |
| C3 | P3 | A11y | [`navigation-panel.tsx`](../src/components/navigation-panel.tsx) | Session rows wrapped in `Tooltip`; focus order is OK but very long titles only in tooltip — truncation may hide context for sighted users (not strictly WCAG failure). | Consider `title` on row or ellipsis + tooltip. |
| C4 | P3 | A11y | Mobile drawer | MUI `Drawer` temporary — rely on MUI focus trap/restore; no extra `aria-label` on drawer paper. | Optional: `PaperProps` `aria-label` for “Navigation”. |

---

## 3. Playground and chat

**Files:** [`playground.tsx`](../src/pages/chatbot/playground/playground.tsx), [`chat.tsx`](../src/components/chatbot/chat.tsx), [`chat-input-panel.tsx`](../src/components/chatbot/chat-input-panel.tsx), [`chat-message.tsx`](../src/components/chatbot/chat-message.tsx), [`useWebSocketChat`](../src/hooks/useWebSocketChat.ts) (referenced).

### Strengths

- Visually hidden `h1` “ABE Chat”; message region `aria-live="polite"`; completion `aria-live="assertive"` sr-only span.
- Input `aria-label="Type your message to ABE"`; send / mic / stop buttons labeled.
- Suggested prompts use `aria-label` including full prompt text.
- Errors use `addNotification` (not raw stack traces in UI).

### Findings

| ID | Severity | Type | Location | Issue | Suggestion |
|----|----------|------|----------|-------|------------|
| P1 | P2 | UX / robust | [`chat.tsx`](../src/components/chatbot/chat.tsx) | Suggested prompt click uses `document.querySelector("textarea")` — fragile if another textarea exists or DOM changes. | `useRef` on `ChatInputPanel` textarea and callback. |
| P2 | P2 | A11y | Streaming | Streaming partial text updates in live region may be noisy for screen readers (polite flood). | Consider `aria-busy` on assistant message container while streaming, or reduce live region churn. |
| P3 | P3 | UX | Session load error | `catch` shows `error.message` — ensure API never returns internal details (backend contract). | Already aligned with security rules; spot-check API. |
| P4 | P3 | WCAG | [`chat-message.tsx`](../src/components/chatbot/chat-message.tsx) | Feedback modal / sources / markdown — verify heading order and focus trap inside dialog (manual pass). | Manual SR check on thumbs-down flow. |

---

## 4. Sessions

**Files:** [`sessions.tsx`](../src/pages/chatbot/sessions/sessions.tsx), [`components/chatbot/sessions.tsx`](../src/components/chatbot/sessions.tsx) (imported).

### Findings

| ID | Severity | Type | Location | Issue | Suggestion |
|----|----------|------|----------|-------|------------|
| S1 | P3 | UX | Breadcrumb | Links to `/` (landing) not current chat home — may be intentional. | Confirm IA with product; document in help. |
| S2 | P3 | A11y | [`sessions.tsx`](../src/components/chatbot/sessions.tsx) | Table has `aria-label`; row/header checkboxes have `aria-label`. Delete dialog uses `aria-labelledby`. | Spot-check bulk delete focus return after dialog close. |

---

## 5. Admin: Data, Metrics, LLM evaluation

### Data dashboard

**Files:** [`data-view-page.tsx`](../src/pages/admin/data-view-page.tsx), [`documents-tab.tsx`](../src/pages/admin/documents-tab.tsx), [`file-upload-tab.tsx`](../src/pages/admin/file-upload-tab.tsx), [`data-indexes-tab.tsx`](../src/pages/admin/data-indexes-tab.tsx).

| ID | Severity | Type | Location | Issue | Suggestion |
|----|----------|------|----------|-------|------------|
| D1 | P1 | Hygiene | [`data-view-page.tsx`](../src/pages/admin/data-view-page.tsx) | `console.error` in `refreshSyncTime` | Remove or gate behind dev; surface user-visible error if sync status unknown. |
| D2 | P1 | Hygiene | [`documents-tab.tsx`](../src/pages/admin/documents-tab.tsx) (multiple) | `console.error` in production paths | Replace with notifications or silent logger. |

### Metrics

**File:** [`metrics-page.tsx`](../src/pages/admin/metrics-page.tsx).

| ID | Severity | Type | Issue | Suggestion |
|----|----------|------|-------|------------|
| M1 | P2 | WCAG 1.4.1 / 1.4.3 | Charts (Line/Bar) and chips — meaning and contrast | Verify series colors + labels; don’t rely on color alone for KPI meaning. |
| M2 | P2 | UX | Large page — loading skeletons present; confirm error states for failed API | User-visible retry where missing. |

### LLM evaluation

**Files:** [`llm-evaluation-page.tsx`](../src/pages/admin/llm-evaluation-page.tsx), [`detailed-evaluation-page.tsx`](../src/pages/admin/detailed-evaluation-page.tsx), [`evaluation.tsx`](../src/pages/admin/evaluation.tsx), `*-eval-tab.tsx`, [`test-cases-tab.tsx`](../src/pages/admin/test-cases-tab.tsx).

| ID | Severity | Type | Location | Issue | Suggestion |
|----|----------|------|----------|-------|------------|
| E1 | P2 | UX | `llm-evaluation-page` | Tabs driven by **hash**; browser back/forward works — good. Initial `navigate(...#dashboard)` replaces history once. | Document for testers. |
| E2 | P2 | WCAG | `detailed-evaluation-page` | Score cards use color backgrounds (`success`/`warning`/`error`) for meaning | Pair with visible score text (partially present); verify contrast on `*.light` backgrounds. |
| E3 | P2 | Hygiene | [`evaluation.tsx`](../src/pages/admin/evaluation.tsx) | `console.log` in catch paths | Remove. |
| E4 | P2 | Hygiene | [`test-cases-tab.tsx`](../src/pages/admin/test-cases-tab.tsx) | `console.error` | Same as D2. |

---

## 6. Help and landing

### Help ([`how-to-use.tsx`](../src/pages/help/how-to-use.tsx))

- Good: section headings `component="h2"`; expandable rows use `aria-expanded`.
- **H1:** Confirm single logical h1 for page (MUI Typography hierarchy).
- **P3:** `ListItemButton` expanders could link `aria-controls` to panel `id` for stronger 4.1.2 association.

### Landing pages ([`landing-page.tsx`](../src/pages/landing-page.tsx), `landing-page-info`, `landing-page-start`)

- **Styled-components** + gradient hero — run **contrast check** on white/light text on `#0a2b48` / `#14558f`.
- **Skip** control present on landing — good.
- **P3:** Ensure focus order matches visual order (absolute header buttons).

---

## 7. Engineering hygiene (console / alert)

- **`alert(`:** None found in `src/**/*.ts(x)`.
- **`console.log` / noisy logging** (non-exhaustive; highest impact):
  - [`metrics-client.ts`](../src/common/api-client/metrics-client.ts) — **many** `console.log` / error logs (PII/telemetry risk in browser console).
  - [`utils.ts`](../src/common/utils.ts) — `console.log` / `console.error`.
  - [`sessions-client.ts`](../src/common/api-client/sessions-client.ts) — `console.log(e)`.
  - [`use-navigation-panel-state.ts`](../src/common/hooks/use-navigation-panel-state.ts) — `console.log(state)` (debug leak).
  - [`evaluation.tsx`](../src/pages/admin/evaluation.tsx) — `console.log`.

**Recommendation:** Strip or wrap with `import.meta.env.DEV` (or a proper logger) per [frontend-ui-guide.mdc](../../../.cursor/rules/frontend-ui-guide.mdc).

---

## 8. Catch-all redirect (`app.tsx`)

[`app.tsx`](../src/app.tsx): `path="*"` → `Navigate` to new playground UUID.

| ID | Severity | Issue | Suggestion |
|----|----------|-------|------------|
| X1 | P3 | UX | Typo URLs silently become a **new** chat session | Consider dedicated `/not-found` with link to home/help, or log metric for `*` hits. |

---

## 9. Verification checklist (recommended)

1. **Axe DevTools** (or `@axe-core/react` in dev): every route in §1 with appropriate role (admin vs non-admin).
2. **Keyboard:** Skip link → main → primary actions per surface; chat send/stop; one admin table sort/dialog.
3. **Screen reader:** Chat: send message, hear response announcement; open one source link. Admin: one sortable table header.
4. **Build:** `npx tsc --noEmit && npx vite build` in `lib/user-interface/app` after fixes.

---

## 10. Prioritized backlog summary

| Tier | Themes |
|------|--------|
| **P0** | None blocking identified in static review (Feedback Manager previously addressed separately). |
| **P1** | Remove/guard `console.*` in admin data paths and **metrics-client**; avoid leaking debug state (`use-navigation-panel-state`). |
| **P2** | Header playground navigation clarity; admin nav `selected` for nested routes; chat textarea ref vs `querySelector`; metrics/eval color + contrast; detailed eval score presentation. |
| **P3** | Catch-all behavior; landing contrast audit; help `aria-controls`; mobile drawer label; minor chat SR streaming polish. |

---

## 11. Feedback Manager regression

Baseline patterns and manual checklist: [`src/pages/admin/feedback-ops/ACCESSIBILITY.md`](../src/pages/admin/feedback-ops/ACCESSIBILITY.md).

**On each release touching admin feedback:**

- Re-run axe on `/admin/user-feedback` and one deep-linked detail.
- Keyboard: open detail drawer, save review, activity drawer.
- Confirm notifications still announce via updated `notif-flashbar` behavior.

---

## 12. Document maintenance

Update this file when:

- New routes are added in `app.tsx`.
- Large new surfaces ship (new admin section, new chat feature).
- After major MUI or theming upgrades (re-run contrast assumptions).
