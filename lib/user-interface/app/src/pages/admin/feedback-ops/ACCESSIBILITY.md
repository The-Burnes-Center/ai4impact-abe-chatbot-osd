# Feedback Manager — WCAG 2.1 AA audit notes

This folder implements the admin Feedback Manager (queue, trends, prompts). Use this checklist when changing these screens.

## Automated

- Run **axe DevTools** (or `@axe-core/react`) on:
  - `/admin/user-feedback`
  - `/admin/user-feedback/:feedbackId` (with a valid id)
- Fix **critical** and **serious** issues before merge.

## Keyboard (manual)

- Tab through header → tabs → queue filters → list rows → pagination.
- Open a feedback row (Enter/Space), complete fields, Save, close drawer (Esc and close button).
- Open Activity log drawer from timeline icon; close with Esc.
- Trends: activate a cluster card and “View example” / “Fix prompt” without mouse.
- Prompts: sidebar, AI Draft dialog, publish confirm (type “publish”).

## Screen reader (spot-check)

- **VoiceOver** (Safari) or **NVDA** (Firefox): confirm tab names, list selection (`aria-selected` / `aria-current`), drawer titles (`aria-label`), and that notifications are announced (see `notif-flashbar`).

## Implemented patterns (baseline)

- **Notifications:** Per-alert `role` / `aria-live` (`assertive` for errors, `polite` for others) in `src/components/notif-flashbar.tsx`.
- **Loading:** A wrapping `Box` with `role="progressbar"` and `aria-label` around `LinearProgress` in Inbox and Prompt workspace (MUI `LinearProgress` typings omit `slotProps` in this project).
- **Detail / activity drawers:** `PaperProps` with `role="dialog"`, `aria-modal="true"`, and `aria-label`.
- **Inbox list:** `role="list"` / `listitem`, `aria-selected`, `aria-current` on the active row.
- **Trends clusters:** No keyboard trap when `sampleFeedbackId` is missing (`tabIndex={-1}`, `aria-disabled`).

## Open risks (re-verify after visual changes)

- **1.4.3 Contrast:** Small overline/caption text and colored panels (`error.50`, stacked bar labels) — re-check with a contrast tool.
- **1.4.11:** Focus ring visibility on dense chip/toolbar controls.
- **Focus management:** MUI `Drawer`/`Dialog` default focus restore; regress after upgrading `@mui/material`.
