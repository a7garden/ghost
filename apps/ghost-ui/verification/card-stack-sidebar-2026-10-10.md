# Right sidebar card stack verification

The right conversation sidebar uses Garden 0.1.0 public `GPanel` and `Card` components. Selected source files are preserved unchanged with hashes in `vendor/garden-ui/ghost-adoption.json`. Ghost owns the inset geometry and existing semantic-token adapter. This is scoped component adoption, not a full Garden application migration; Garden sync/doctor lifecycle commands do not apply without a Garden app manifest.

Reference implementation inspected: sibling `codex-clone/src/styles/cards.css` (individual rounded card surfaces), `src/styles/thread.css` (scrolling support content), and Garden `contracts/ui-spec/layout.md` (controlled inset context panels and focus return).

Executed `npm run build`, `npm test` (34 Vitest files, 176 tests; 10 bridge tests), and `git diff --check`: all passed. Garden selected-source hashes match 8/8.

Running app: `http://127.0.0.1:5178`, Sage conversation, 1280×720 and 375×812.

- Desktop: one right sidebar, one card stack, six actual Garden cards. Computed card radius 15px and dark surface rgb(33,33,33). No viewport horizontal overflow.
- Open activity and collaboration cards, close entire stack, reopen: both cards retain their expanded state.
- Close via Garden panel close button: panel removed and focus returns to the conversation toggle.
- Resize while open to 375px: zero desktop sidebars, one dialog, same six cards, no horizontal overflow.
- Escape from narrow dialog: dialog removed and focus returns to the toggle.
- Return to desktop, reopen, reload: sidebar remains open.

Screenshot: `/Users/garden/Documents/Codex/ghost-card-stack-sidebar-2026-10-10.jpg`. Voice calls and domain write actions were not exercised.
