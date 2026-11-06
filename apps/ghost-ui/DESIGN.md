# Ghost UI decisions

- The independent unit is **Ghost**. OpenAI Dots, OpenDots, and OpenMuse are references, not product terminology.
- Every Ghost has the same durable runtime; mark only the default entry point. A request starts from **새 요청**, addressed to the default Ghost; delegation happens between Ghosts, not by the owner picking a recipient first.
- A work deep link preserves its exact goal, work and conversation while opening the detail. Ghost creation and activation require an explicit owner action; a pasted route never authorizes registration. Retired submit/steer operations must not appear as working actions.
- Page headings name the destination. Do not append promotional subtitles, rhetorical slogans, English eyebrow labels, or companionship copy. Show actual state and actionable labels. Help belongs beside a field or in an empty/error state when needed.
- Collaboration reflects persisted delegation lineage. Group parallel tasks by their generation parent, show the requesting and receiving Ghosts, preserve failure/uncertainty, and link to both conversation and protocol history. Do not invent a connected team graph from all profiles.
- Example data is explicitly labeled and kept separate from the host. No fake live terminal, browser, voice call, or model execution.
- Keep this package independent from the Rust host and the existing embedded UI. Concurrent backend and integrations work must be preserved.
- Keep the current Ghost icon, per the latest owner instruction.

## Garden system — 2026-11-06

The console adopts Garden (`garden.json`, `vendor/garden`). Controls are Garden's
shadcn/ui-style, Radix-backed `@garden/ui` components; layout and color use Tailwind 4
utilities bound to Garden's generated tokens. There is no app-level control library or
global stylesheet beyond `src/app.css` (root sizing) and `src/pets/pets.css` (avatar
sprites). Deliberate departures are recorded in `garden.json` and `docs/decisions/`.

`GAppShell` owns the frame. The activity rail selects one of four workspaces and the
sidebar lists only that workspace's destinations:

| Rail | Sidebar | Main |
|---|---|---|
| 대화 | 새 요청, Ghosts (default first); the open Ghost expands into 대화 · 맡은 일 · package views · 이전 대화 | `GConversation` with `GComposer` |
| 일 | 확인 필요 · 모든 일 · 협업 | `GPage` lists of `WorkRow` |
| 프로젝트 | Projects (document spaces) and 새 프로젝트 | Project page |
| 설정 | — | `GSettings`: 팀 · 모델 · 확장 · 호스트 · 화면 · 아바타 |

The title bar shows the current location and the shell's command field (`⌘P`, also `⌘K`).
Host trouble surfaces on the settings rail item and as a banner; healthy state is silent.
Theme follows the `.dark` class on `<html>`.

Earlier designs (Docket console, dashboard of 2026-11-04) are history:
[redesign report](../../docs/dashboard-redesign-2026-11-04.md),
[review surface design](../../docs/ghost-conversation-review-surfaces.md).
