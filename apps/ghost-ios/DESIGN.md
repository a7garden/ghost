# Ghost Mobile

The native iPhone client shares Ghost's quiet neutral identity. The 2026-11-04 owner direction keeps direct conversation central and makes every granted Ghost accessible without an external messenger.

## Structure

Conversation is the default. Restore the last explicitly selected, still-authorized Ghost/conversation; otherwise choose the registered default or the sole active authorized target. All Ghosts have the same durable runtime. A continuous transcript (Long Document family), a compact edge-aligned native header (N9), and a persistent composer are the primary surface. The work list uses Index First: real requests, human-readable states, results and approval needs. Owner decisions, unresolved requests and result notifications share the third destination, 확인할 일. Settings, scope details and recovery diagnostics open on demand. No marketing hero, fake device chrome, website footer or fabricated activity.

The existing web design's repeated Workbench structure does not govern this native app. These screens share one system rather than rotating themes per destination.

## Theme and tokens

Modern minimal, Coral adaptation: warm near-white canvas, porcelain surfaces, charcoal text, restrained accent reserved for controls and meaningful states. Dark mode uses opaque warm charcoal surfaces and light ink. SwiftUI's `GhostStyle` is the runtime token authority; `tokens.css` is the portable reference. Use SF system type with Dynamic Type, a rounded display variant only for the empty conversation, and monospaced type only in disclosed technical details.

Spacing: 4/8/12/16/20/24/32. Primary controls have at least44pt hit targets. Messages use open assistant text and a distinct trailing user bubble. No nested card grids, gradients, decorative orbs, invented counters or technical UUIDs in the default conversation.

## Interaction

The composer stays above the keyboard and system tab bar. Sending preserves the existing durable draft/receipt contract; a lost acknowledgment remains unresolved and is never silently retried. Earlier-message reading must not jump when refresh brings new content. A visible header picker switches between named authorized Ghosts. Privacy and existing-artifact attachments live in conversation options. Their original authority and disclosure guards remain enforced.

Work summaries distinguish running, produced, accepted, failed and unconfirmed. Completion is not acceptance. Approval details must still show the exact operation, destination, input and target before any decision. Technical facts can be disclosed within the relevant detail rather than injected into every default screen.

Every action states its real outcome: sending, stopping a response, cancelling or resuming a Work, resolving a decision, and reading a notification each show their own disabled, loading, error, offline, empty, pending and settled states. Nothing promises a route the host does not serve, and success is shown in place, without celebratory toasts.

## Motion and accessibility

Use native navigation and short opacity/press transitions, no page-load animation. Honor Reduce Motion. Maintain Dynamic Type, VoiceOver labels, selected-state semantics, meaningful focus, contrast and safe areas. Verify compact phone widths, the actual iPhone14, larger phone/tablet widths and dark mode. Preserve the existing app bundle/Keychain on device reinstall.

## Pairing and equality

The owner chooses the exact Ghost/conversation pairs for a new phone connection.
The phone validates the saved origin and code before claiming, then stores the
issued device credential. Adding another Ghost later does not silently expand a
device grant: the host filters every read and command by the device's grants.
Existing grants retain their original scope. Display actual Ghost names, not raw
IDs as default navigation labels.

Switching keeps each draft in its original pair, clears pending attachment selection,
and restores the chosen conversation after reopening. An uncertain send remains tied
to its original request and cannot become a fresh send to another Ghost. Provider
selection errors lock apply until a fresh read; tentative consent resets on reconnect.

The app talks directly to the paired host API on one origin. There is no separate
relay process and no external messenger dependency. APNs hardware acceptance and
actual installed-device rollout remain separate from simulator UI verification.
