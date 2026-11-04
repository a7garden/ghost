# Ghost UI decisions

- The independent unit is **Ghost**. OpenAI Dots, OpenDots, and OpenMuse are references, not product terminology.
- Default to a conversation. Ghost switching stays centered in the desktop titlebar; work, approvals, documents, and collaboration remain reachable without losing the conversation.
- Page headings name the destination. Do not append promotional subtitles, rhetorical slogans, English eyebrow labels, or companionship copy. Show actual state and actionable labels. Help belongs beside a field or in an empty/error state when needed.
- Collaboration reflects persisted delegation lineage. Group parallel tasks by their generation parent, show the requesting and receiving Ghosts, preserve failure/uncertainty, and link to both conversation and protocol history. Do not invent a connected team graph from all profiles.
- Reuse Codex tokens: neutral surfaces, restrained separators, inverse primary actions, color in identity and meaningful states. Keep an anchored composer, visible focus, readable mobile layouts, and reduced-motion support.
- Example data is explicitly labeled and kept separate from the host. No fake live terminal, browser, voice call, or model execution.
- Keep this package independent from the Rust host and the existing embedded UI. Concurrent backend and integrations work must be preserved.
- Keep the current Ghost icon, per the latest owner instruction. Do not spend further work locating or replacing the previous icon.

## Docket console

The console uses flat neutral surfaces, a fixed sidebar with a hairline divider, and inverse primary buttons. Amber identifies work that needs review, blue identifies work in progress, and red identifies failures or rejection. The workbench groups goals using work from the current goal revision and opens goal actions in a detail drawer that stays mounted as the card changes columns. The shared presentation tokens live in `src/docket-tokens.css`.

The proposed conversation-first layout and approval plug-in contract are in [the review surface design](../../docs/ghost-conversation-review-surfaces.md).

Style reference is [a7garden/docket](https://github.com/a7garden/docket/tree/86c9491fe57a870a36d9b365de5e23c0a9a2f14f).

References: [OpenAI Dots](https://learn.chatgpt.com/docs/dots), [OpenDots](https://github.com/CopilotKit/OpenDots), [OpenMuse](https://github.com/CopilotKit/openmuse). The layout and avatars here are original source code; no third-party UI assets were copied.


## Workspace composition

Docket remains the visual system. Conversations and composers share one reading column. Work, inbox and settings use a wider page column and the same responsive gutter. Page headings identify the destination. Work filters sit with their section heading. An approval row pairs the decision context with its next action. In appearance settings, the category selector provides the section label and fields sit on the page with hairline separators.

Use the named spacing and type tokens in `tokens.css` and the workspace measurements in `src/docket-tokens.css`. Use the existing sans and mono faces. Identity and meaningful states carry color. Borders separate adjacent roles, and elevated surfaces belong to the composer, dialogs and transient menus.

Use `--dur-micro` for control feedback and `--dur-short` for entering a destination or dialog. A short fade and a few pixels of travel are enough. Keep ongoing conversation and work updates still and honor reduced motion.
