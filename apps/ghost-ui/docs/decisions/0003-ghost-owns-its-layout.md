# 0003 Ghost keeps its own layout; Garden supplies controls

Status: accepted, 2026-11-06. Rule: `shell.layout`.

## Decision

The owner adopted Garden for its components, not its application layout. The console
keeps its own frame (`src/components/AppFrame.tsx`): one sidebar beside one main region,
and a title bar that names the location and opens command search. There is no activity
rail, inset canvas or shell-owned pane toggle.

## Replacement behavior

- Sidebar: 홈 (pending-decision count), Ghosts (default first; the open Ghost expands
  into 대화 · 맡은 일 · package views · 이전 대화), 프로젝트, and 설정 at the bottom with
  host trouble shown only when the host is not connected.
- Below 56rem the sidebar moves into a menu dialog opened from the title bar.
- Command search is Garden's `GCommandPalette` (`⌘P`, also `⌘K`).
- Conversation transcript: Garden's `GConversation` stays, but the Owner's message is a
  full-width block in reading order instead of the trailing phone-style bubble
  (`src/app.css`). The conversation has no refresh or new-conversation buttons; reads
  poll, and a failed read retries when the window is used again.
- All controls, settings, conversation and feedback components remain `@garden/ui`.

## Verification

Home, a Ghost conversation, 맡긴 일 and settings are opened in the running console in
example mode and against a development Host.
