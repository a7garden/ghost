# Ghost console design

The console's application rules live in [Ghost UI decisions](apps/ghost-ui/DESIGN.md).
The 2026-11-07 redesign replaces the Docket console and the 2026-11-04 dashboard.

## Product and hierarchy

Every Ghost is an independently identifiable durable agent with Pi Durable built in. One is
the default entry point; durability is not a special property of the default Ghost.

Home is where the owner hands work off and settles what waits on them: an addressed
hand-off composer, the decision deck, live Work as lanes and recently finished Work. The
sidebar keeps 홈 · 확인할 일 · 맡긴 일, every Ghost with its live presence, projects and
settings. The title bar carries the location, the activity island and command search.
Page headings identify the destination without promotional subtitles.

## Presentation

Neutral layered surfaces separated by soft shadows; color communicates identity or agent
state only. Signal blue means a Ghost is working, amber means something waits on the
owner, red means failure and green an accepted result. Each state also has its own glyph
shape. Inter and JetBrains Mono remain; no new runtime dependencies. Tokens live in
`apps/ghost-ui/src/ui/theme.css`; component styles in the `components` cascade layer.
Respect reduced motion: rings, sheens and streaming carets stop.

## State is part of the design

- Connected means a recent successful Host snapshot, not merely live configuration.
- Work state comes from the host ledger. Execution completion remains separate from
  acceptance; a Work with a pending decision reads as 확인 필요 whatever its step.
- Saved credentials are configuration, not proof of provider execution.
- Failure preserves the last readable state with a warning; failed settings changes are
  never replayed automatically.

## Screen map

| Destination | Primary purpose |
| --- | --- |
| 홈 | Hand-off, decisions, live and recent Work |
| 확인할 일 | Every pending decision, host notifications, settled decisions |
| 맡긴 일 | Delegation trees by state and assignee; detail with lifecycle, decisions, result, delegation map and effects |
| Conversation | Continuous transcript, tool trails, anchored composer, scoped model choice |
| 프로젝트 | Document spaces and pages |
| 설정 | Ghost settings, models, devices, schedules, host, display, desktop avatar (Mac app) |

Follow `docs/pdc-adoption.md` for the user document plane.
