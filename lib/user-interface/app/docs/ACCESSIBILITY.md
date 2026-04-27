# ABE Accessibility (WCAG 2.1 AA)

ABE is built to live as a `.mass.gov` sub-domain. Per the
[Massachusetts Web Design Guidelines](https://www.mass.gov/policy-advisory/web-design-guidelines)
constituent-facing sites must meet **WCAG 2.1 AA**. This document captures
the accessibility patterns we follow, how to test changes, and known
limitations.

## How to test

### 1. axe DevTools (browser extension)

- Install the free Deque
  [axe DevTools](https://www.deque.com/axe/devtools/) Chrome / Firefox / Edge
  extension.
- Open the page in a fresh, signed-in session.
- DevTools → axe DevTools panel → "Scan ALL of my page".
- Triage criticals + serious. Document any "needs review" you accept.

### 2. @axe-core/react (dev console)

- Already wired in `src/main.tsx` (only loads in `import.meta.env.DEV`).
- Open the browser DevTools console; violations stream in as components mount.
- Treat every critical / serious as a blocker.

### 3. vitest-axe (CI)

- See `src/test/a11y/*.test.tsx`.
- Run with `npm run test`. Fails the build on violations.

### 4. Manual keyboard pass

- Tab from page load. Expected order:
  1. Mass.gov BrandBanner expansion toggle
  2. "Skip to main content" link (`components/mds/SkipLink.tsx`)
  3. ABE GlobalHeader items (logo, help, theme, account)
  4. NavigationPanel items (sidebar routes only)
  5. Main content interactive elements
  6. Mass.gov Footer links
- No keyboard traps. Focus must always be visible.
- `Esc` closes any open dialog/drawer and returns focus to its trigger.

### 5. Screen reader spot-check

- macOS VoiceOver (`Cmd+F5`) on Safari, OR NVDA on Firefox.
- Verify:
  - Page title announced on route change.
  - Headings list (VO+U → Headings) reads logically with one `<h1>` per page.
  - Chat responses announced via `aria-live`.
  - Dialog titles announced when drawers/modals open.

### 6. Lighthouse

- Chrome DevTools → Lighthouse → Accessibility.
- Target ≥ 95 on every route.

## Routes covered

Document titles are produced by `useDocumentTitle(...)` in
`src/common/hooks/use-document-title.ts`, which appends ` | ABE`.

| Route | Document title | Notes |
| ----- | -------------- | ----- |
| `/` | Home \| ABE | Public landing page |
| `/about` | About \| ABE | Public about page |
| `/get-started` | Get started \| ABE | Public CTA page |
| `/chatbot/playground/:sessionId` | Chat \| ABE | Streaming responses use `role="log"` + `aria-live="polite"` |
| `/chatbot/sessions` | Chat sessions \| ABE | List with `aria-current` on active row |
| `/admin/data` | Admin · Data \| ABE | Tables with `aria-sort` |
| `/admin/metrics` | Admin · Metrics \| ABE | MUI charts have `aria-label`; consider tabular alternative |
| `/admin/user-feedback` | Admin · User feedback \| ABE | Drawer dialogs with `role="dialog"` + `aria-modal` |
| `/admin/user-feedback/:feedbackId` | Admin · User feedback \| ABE | Detail view |
| `/admin/llm-evaluation` | Admin · LLM evaluation \| ABE | Sortable result tables |
| `/admin/llm-evaluation/:evaluationId` | Admin · Evaluation details \| ABE | |
| `/help` | Help \| ABE | Single `<h1>`, semantic sections, tabbed panels with `role="tabpanel"` |
| `*` (wildcard) | Page not found \| ABE | Clear "Return to home" CTA |

Legacy routes that redirect (no titled page):

- `/chatbot/tips` → `/help`
- `/faq-and-guide/*` → `/help`

## Patterns we use

- **Skip link** (`components/mds/SkipLink.tsx`) — first focusable element on
  every page; targets `#main-content` (the `<main tabIndex={-1}>` wrapper in
  `components/base-app-layout.tsx`).
- **Live regions** — chat stream uses `role="log" aria-live="polite"`;
  toasts/alerts use `notif-flashbar`'s per-alert `role` (`assertive` for
  errors, `polite` otherwise).
- **Dialogs** — MUI `<Drawer>` / `<Dialog>` with
  `role="dialog" aria-modal="true"` and an `aria-label` or
  `aria-labelledby`.
- **Tabs** — MUI `<Tabs>` with explicit `id` + `aria-controls` and a
  matching `role="tabpanel"` `<Box>` wrapping each panel
  (see `pages/help/how-to-use.tsx`).
- **Forms** — every input has a label (visible or `aria-label`); validation
  errors associated via `aria-describedby` + `role="alert"`.
- **Status not by colour alone** — `status-chip.tsx` always pairs colour
  with an icon and text.
- **Decorative imagery** — MUI icons that sit next to text labels are
  `aria-hidden="true"` (e.g. expand chevrons, sidebar admin icons,
  the error-boundary `ErrorOutlineIcon`).
- **`aria-current="page"`** — set on the active session and admin link in
  `components/navigation-panel.tsx` so screen readers announce the current
  location.
- **Error boundary** (`components/error-boundary.tsx`) — fallback `<Paper>`
  has `role="alert"` and an `<h2>` heading; both buttons carry an
  `aria-label`.
- **Reduced motion** — global `@media (prefers-reduced-motion: reduce)`
  rule in `styles/app.scss` disables animations.
- **Focus indicators** — global 3px solid `#0088FF` `outline-offset: 2px`
  in `styles/app.scss`. Never set `outline: none` without an equivalent
  replacement.
- **External links** — open with `target="_blank" rel="noopener noreferrer"`
  and a visible "(opens in new tab)" cue or equivalent `aria-label`.

## Resolved findings (historical scans)

### Apr 2026 axe scan (`ABE_WebAccessibility.xlsx`)

| Severity | Rule | Page | Status |
| -------- | ---- | ---- | ------ |
| Serious  | [`aria-progressbar-name`](https://dequeuniversity.com/rules/axe/4.11/aria-progressbar-name) | Chatbot playground (small `<CircularProgress>` had `role="progressbar"` but no accessible name) | **Fixed** — every `<CircularProgress>` in the codebase now either carries `aria-label` + `role="status"` (when it is the sole loading indicator) or `aria-hidden="true"` (when paired text or a parent `role="status"` already conveys the loading state). |
| Serious  | [`list`](https://dequeuniversity.com/rules/axe/4.11/list) | `/help` (Tips & Questions) — a `<ul>` from MUI `<List>` had `<div>` children | **Fixed** — `pages/help/how-to-use.tsx` now wraps each prompt / sample-question row in `<Box component="li">` so the `<ul>`'s direct children are real `<li>` elements. |

## Known limitations

- The Mayflower `<BrandBanner />` is an upstream Massachusetts Digital
  Service component. Its collapsed "Here's how you know" section emits a
  `region` landmark without a label; we accept this as upstream behaviour
  and re-evaluate when Mayflower ships an update.
- MUI `x-charts` on the metrics page describe series but not individual
  data points to screen readers; consider adding a tabular alternative if
  data fidelity is required for users of assistive technology.
- The admin Feedback Manager has its own deeper audit notes in
  `src/pages/admin/feedback-ops/ACCESSIBILITY.md`. Re-run that checklist
  when changing those screens.

## Adding a new route or component

1. Add `useDocumentTitle("...")` at the top of the page component.
2. Use a single `<h1>`; nest only with semantic `<h2>` / `<h3>`.
3. If interactive, give every control an accessible name (visible label,
   `aria-label`, or `aria-labelledby`).
4. Decorative icons get `aria-hidden="true"` (or `alt=""` for `<img>`);
   meaningful imagery gets descriptive `alt` text.
5. Run `axe DevTools` → "Scan ALL of my page" on the new route.
6. Add (or extend) a `vitest-axe` test in `src/test/a11y/`.

## References

- [WCAG 2.1 AA quick reference](https://www.w3.org/WAI/WCAG21/quickref/?versions=2.1&levels=aa)
- [Mass.gov Web Design Guidelines](https://www.mass.gov/policy-advisory/web-design-guidelines)
- [Massachusetts Design System (Mayflower)](https://mayflower.digital.mass.gov/)
- [Mass.gov Accessibility Statement](https://www.mass.gov/info-details/commonwealth-of-massachusetts-executive-department-digital-accessibility-statement)
