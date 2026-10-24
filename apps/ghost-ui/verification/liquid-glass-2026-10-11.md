# Ghost Glass verification — 2026-10-11

## Scope

Shared console presentation layer, product tokens, sidebar wordmark and overview
layout. Existing work in the checkout was retained. No runtime dependencies,
backend commands, document formats or document renderers were changed.

## Checks completed

- `npm test` in `apps/ghost-ui`: 184 Vitest tests (36 files) and 10 bridge tests pass.
- `npm run build`: TypeScript and production build pass. Existing large-bundle
  warning remains (main JS exceeds 500 kB).
- In-app Chromium preview using isolated demo mode at `127.0.0.1:5188`.
- Ten screens at desktop: overview, work, inbox, planner, integrations,
  collaboration, spaces, appearance, avatars and models.
- Light theme: 40 route/width combinations at 320, 375, 414 and 768px; no main
  content elements outside the viewport or root horizontal overflow.
- Dark theme: the same routes plus conversation at those four widths (44
  combinations); no main content elements outside the viewport.
- Visual checks: desktop light/dark overview, settings, planner, collaboration,
  conversation with/without context, mobile conversation, planner and navigation.
- Interaction checks: theme switch, context open/close, mobile navigation,
  search from navigation, text filtering and Enter to open a result, modal
  opening/closing, task structure editor opening.
- The 320px structure editor preserves its intentionally horizontally scrollable
  graph canvas; the dialog itself remains within the viewport.
- Reduced motion/transparency and increased contrast emulated via CDP: toolbar
  uses an opaque background with `backdrop-filter: none`; motion is effectively
  disabled (the pinned Arc adapter uses a 0.01ms transition).
- Fixed nested Arc theme overriding product semantic colors and Arc adapter
  hiding text-field focus. Verified a visible 2px product focus ring.
- Browser error log empty after the demo walkthrough.
- Production build confirmed on the existing live console at `127.0.0.1:5178`: host data loads, the Ghost wordmark is present, sidebar blur is 24px, and the canvas radius is 28px. No host actions were submitted.
- Native document content, live model/voice execution, conditional Lifetime UI,
  external integrations and Safari are not end-to-end tested in this change.

## Evidence

- `../evidence/liquid-glass/overview-light.jpg`
- `../evidence/liquid-glass/overview-dark.jpg`
- `../evidence/liquid-glass/conversation-light.jpg`
- `../evidence/liquid-glass/planner-mobile.jpg`

## Design assessment

Philosophy 5, hierarchy 4, execution 4, specificity 5, restraint 5, consistency 4.
The owner-requested glass treatment and Apple system typography override the
skill's generic anti-glass and non-system-font defaults. No invented metrics,
marketing sections, decorative gradients, new typefaces or ambient animation.


## Compact refinement — second computer-use pass

The owner requested another full layout/component review with smaller buttons
and spacing. The browser walkthrough found and fixed a hidden-filter problem:
closing the previous Ghost search field left its query active. Collection search
now remains visible, with a clear button and Escape reset. Prompt suggestions
now focus the composer after inserting their text.

- Desktop buttons/navigation: 32px; icon controls: 30px; touch controls: 44px minimum.
- Navigation width: 236 → 224px; topbar: 64 → 52px; shell gutter: 12 → 8px.
- Live Ghost cards measure 94.75px high; idle overview uses two columns instead
  of reserving an empty running-work column. No running indicator when count is zero.
- Empty conversations group suggestions and composer with a measured 32px gap
  at both 1280×800 and 1920×1200. Populated conversations retain the bottom input.
- Planning controls/cards, settings rows, document thumbnails, context cards and
  collaboration avatars/cards use the revised density.
- `npm test`: 185 Vitest tests and 10 bridge tests pass. Added the conditional
  activity-rail regression and empty/active conversation layout assertions.
- Final `npm run build`: passes; the pre-existing >500 kB bundle warning remains.
- Computer use: search by name, clear, no-results state, Escape; conversation
  suggestion selection and focus; mobile context open/close; global search and
  Enter navigation; collaboration drawer open/close; settings/theme navigation.
- Isolated demo planner: created “컴팩트 레이아웃 확인”, marked it complete,
  and verified it appears in the completed filter. No live task or message submitted.
- 44 route/width checks across 11 screens at 320, 375, 768 and 1024px in dark mode:
  no root horizontal overflow or measured controls/headings outside the viewport.
- Desktop light theme visually checked for overview, planner, settings and empty
  conversation. Dark collaboration and live overview/conversation visually checked.
- 320×480: empty conversation scrolls and the send control remains reachable.
  Touch emulation at 320px confirmed 44px toolbar targets, including history.
  Touch emulation and viewport override restored after testing.
- Final live console: five Ghosts load, search clears back to all five, no idle
  activity rail, and grouped empty input renders correctly. Browser error log empty.
- Same untested boundaries as the first pass: native document content, real model
  or voice execution, conditional Lifetime UI, external integrations and Safari.

New evidence:

- `../evidence/liquid-glass/compact-overview-live.jpg`
- `../evidence/liquid-glass/compact-conversation-live.jpg`
- `../evidence/liquid-glass/compact-conversation-mobile.jpg`


## Conversation focus refinement — third pass

- Removed the empty-thread avatar/name/status hero. The existing toolbar retains
  Ghost identity; the input gets a one-line role excerpt and full-instructions link.
- Starter buttons now show short role-based labels below the composer. Selecting
  one still inserts the full prompt and focuses the input; nothing is auto-sent.
- First message removes empty-state guidance and restores the anchored input.
- The chat toolbar aligns with the canvas edge. The composer is opaque and has
  one 2px keyboard-focus boundary, avoiding nested textarea and composer rings.
- Shared geometry: shell 14px, cards 10px, fields/buttons 8px, composer 12px.
- Neutral porcelain/charcoal surfaces replace the blue cast; accents use a softer
  blue, message bubbles are neutral, and the send button has a monochrome fill.
- `npm test`: 185 Vitest tests plus 10 bridge tests passed. Final production build
  passed; the existing bundle-size warning remains. No new dependencies.
- Computer-use demo: starter click/focus, full draft text, first-message submission
  and response, new conversation, light/dark themes, desktop context and mobile drawer.
- Empty and populated threads at 320, 375, 768 and 1280px: eight checks, no root
  horizontal overflow or visible controls extending beyond the viewport.
- At 320×480 with touch emulation, starter buttons measured 44px, composer/send
  remained visible, and selection focused the textarea. Emulation was restored.
- Live console at 1280×800: role row 28.59px, starters 29.20px, composer begins at
  198.59px (previously 510px). Actual composer/card radii confirmed at 12/10px.
  Host data loads and browser error log is empty; no live messages were sent.
- Screenshots: `focused-conversation-light.jpg`, `focused-conversation-mobile.jpg`,
  `focused-conversation-live-dark.jpg` in `../evidence/liquid-glass/`.
- Same integration limitations as above; this verifies presentation and local
  interaction, not model/voice execution or external integrations.


## Balance correction — owner feedback

The top-positioned empty composer made the screen top-heavy. The final layout
centers a compact 44px avatar, name, two-line role excerpt and short starters in
the transcript area. Empty and active conversations now share the same bottom
composer. The transcript region scrolls independently at short heights.

- Production build and 11 targeted conversation layout/starter tests passed.
- Live visual checks at 1280×800 and 375×812; 320×480 measured composer bottom
  472px and welcome bottom 298.45px, with no horizontal overflow or overlap.
- Palette, smaller radii, starter draft/focus behavior and focus ring retained.
- Evidence: `balanced-conversation-live.jpg`, `balanced-conversation-mobile.jpg`.
- No live messages submitted. Viewport and context-panel state restored.
