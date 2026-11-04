# Ghost console design

The current console uses the **Docket** visual system. The 2026-11-04 dashboard
redesign supersedes the earlier Ghost Glass layout guidance in this file.
The detailed application rules are in [Ghost UI decisions](apps/ghost-ui/DESIGN.md).

## Product and hierarchy

Every Ghost is an independently identifiable durable agent with Pi Durable built in. One is the default entry point; durability is not a special property of the default Ghost.
The default destination is the dashboard: current work, decisions awaiting the
owner, and Ghosts. Conversations remain directly accessible from Ghost selection,
the sidebar, and existing deep links. Host, providers, and extensions are dedicated
management destinations rather than overlapping configuration dialogs.

The sidebar groups work, personal workspace tools, and management. A shared toolbar
keeps Ghost switching and command search. The mobile menu exposes every destination.
Page headings identify the destination without promotional subtitles.

## Presentation

Use flat neutral surfaces, fine separators, inverse primary buttons, and the existing
Ghost mark. Color communicates identity or state. Amber means attention, blue means
running work, and red means failure. The existing system sans and monospace stacks
remain; no new fonts, icon systems, or runtime dependencies are introduced.

The current semantic palette and workspace roles live in
`apps/ghost-ui/src/docket-tokens.css`. Legacy token aliases and glass styles remain
compatibility layers for existing surfaces. `apps/ghost-ui/src/dashboard.css` is
loaded after Docket and owns the dashboard, management pages, and sidebar composition.
`apps/ghost-ui/src/features/connections.css` owns provider and extension rows.

Use the named spacing, radius, type and state tokens. Desktop navigation is 216px
wide. Content has a 1160px maximum; task lists and contextual navigation share a
wide screen and stack on smaller screens. Provider editors are disclosed on demand.
Dialogs and transient menus retain visible focus and dismissal behavior. Respect
reduced motion; avoid ongoing animation for data updates.

## State is part of the design

- Connected means a recent successful Host snapshot, not merely live configuration.
  Distinguish connecting, offline, cached, and example states.
- Pi work comes from the current goal revision in the lifetime ledger. Execution
  completion remains separate from acceptance. Old revisions do not inflate counts.
- Saved credentials are configuration, not proof of provider execution. Explain the
  specific auth method. Keep explicit per-conversation external-processing consent.
- MCP check history, enablement, tool permissions and installation are separate facts.
  A cached schema does not imply a new successful connection probe.
- Failure preserves the last readable state with a warning. Lock writes until the
  relevant connection/settings have been checked again; never automatically replay
  a failed settings change.

## Screen map

| Destination | Primary purpose |
| --- | --- |
| Dashboard | Current work, approvals, Ghost access and connection navigation |
| Host | Observed connection, dispatch policy, capabilities and diagnostics |
| Providers | Registered inference providers; disclosed compatibility and voice settings |
| Extensions | MCP tools and permissions, packages, device pairing |
| Conversation | Continuous transcript, anchored composer, scoped model choice |
| Work and inbox | Persisted task/review state and explicit owner actions |
| Documents and planner | Existing document and planning flows |

No user document storage, source bytes, parsing, preview isolation or migration
semantics change. Follow `docs/pdc-adoption.md` for those planes.

## References and verification

[Linear Inbox](https://linear.app/docs/inbox) informed actionable attention placement;
[Tailscale device filtering](https://tailscale.com/docs/features/access-control/device-management/how-to/filter)
informed the separation of current and last-observed state;
[Raycast extension models](https://manual.raycast.com/ai/extension-models) informed
provider disclosure; [Vercel integration management](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference)
informed distinct installation and permissions states. These are interaction references,
not copied assets or a claim to reproduce their current interfaces.

The bounded browser regression checks both themes at 320, 375, 414, 768 and 1440px,
individual control/section bounds, mobile navigation, keyboard search, disconnects
and settings conflicts. See [the implementation report](docs/dashboard-redesign-2026-11-04.md)
for actual evidence and remaining limits.
