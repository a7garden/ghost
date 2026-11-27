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
| 홈 | A desk: the decision queue with its evidence leads, beside a compact hand-off bar and live and recent Work |
| 확인할 일 | Every decision waiting on the owner as a queue beside the selected decision's evidence (recommended answer, hand to the main, put off), what the main is deciding, news and settled decisions |
| 맡긴 일 | One ledger grouped 확인 필요 · 진행 중 · 끝난 일; detail reads the result first, then the instruction, with delegation, environment and run history in a rail only when they exist |
| Conversation | Continuous transcript, tool trails, anchored composer, scoped model choice |
| 프로젝트 | One project as a place: one bar (name, who carries it, folder, tabs, 일 맡기기), then 대화 · 맡긴 일 (what waits on the owner first) · 문서 (index beside the open document) · 목표, with 자동 활동 · 승인 규칙 · 성과와 비용 · 변경 기록 kept under 설정 |
| 목표 | Team and per-project directions with their 이정표 lines, grouped by project |
| 설정 | Ghost settings, models, devices, schedules, host, display, desktop avatar (Mac app) |

Follow `docs/pdc-adoption.md` for the user document plane.
