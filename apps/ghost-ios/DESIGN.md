# Ghost Mobile — conversation first

The native mobile design authority for this redesign. The owner chose a messenger-like first screen on 2026-10-17. It shares Ghost's quiet porcelain/charcoal identity; it is not a mobile administration console.

## Structure

Conversation is the default and returns to the actual canonical Primary. A continuous transcript (Long Document family), a compact edge-aligned native header (N9), and a persistent composer are the primary surface. The work list uses Index First: real requests, human-readable states, results and approval needs. Notifications form the third destination. Settings, scope details and recovery diagnostics open on demand. No marketing hero, fake device chrome, website footer or fabricated activity.

The existing web design's repeated Workbench structure does not govern this native app. These screens share one system rather than rotating themes per destination.

## Theme and tokens

Modern minimal, Coral adaptation: warm near-white canvas, porcelain surfaces, charcoal text, muted coral accent occupying less than 3% of a screen. Dark mode uses opaque warm charcoal surfaces and light ink. SwiftUI's `GhostStyle` is the runtime token authority; `tokens.css` is the portable reference. Use SF system type with Dynamic Type, a rounded display variant only for the empty conversation, and monospaced type only in disclosed technical details.

Spacing: 4/8/12/16/20/24/32. Primary controls have at least44pt hit targets. Messages use open assistant text and a distinct trailing user bubble. No nested card grids, gradients, decorative orbs, invented counters or technical UUIDs in the default conversation.

## Interaction

The composer stays above the keyboard and system tab bar. Sending preserves the existing durable draft/receipt contract; a lost acknowledgment remains unresolved and is never silently retried. Earlier-message reading must not jump when refresh brings new content. Target selection, privacy and existing-artifact attachments live in a conversation-options sheet. Their original authority and disclosure guards remain enforced.

Work summaries distinguish running, produced, accepted, failed and unconfirmed. Completion is not acceptance. Approval details must still show the exact operation, destination, input and target before any decision. Technical facts can be disclosed within the relevant detail rather than injected into every default screen.

Voice controls respect the exact configured Ghost/conversation pair and existing call fences. No fake active call or promised route. Disabled, loading, error, offline, empty, accepted, pending and cancellation states are explicit. Success is shown in place, without celebratory toasts.

## Motion and accessibility

Use native navigation and short opacity/press transitions, no page-load animation. Honor Reduce Motion. Maintain Dynamic Type, VoiceOver labels, selected-state semantics, meaningful focus, contrast and safe areas. Verify compact phone widths, the actual iPhone14, larger phone/tablet widths and dark mode. Preserve the existing app bundle/Keychain on device reinstall.
