# Ghost mobile redesign — 2026-10-17

Owner decision: conversation first, like opening a messenger. Native design authority: [DESIGN.md](../apps/ghost-ios/DESIGN.md).

## Product changes

- Lifetime connections open directly to the canonical Primary transcript and persistent composer. Main destinations are conversation, delegated work and notifications. An exact specialist pair remains selectable in conversation options.
- Human messages use trailing charcoal bubbles; Ghost responses use an open reading layout. Advisory responses remain explicitly labelled as proposals; produced results and independent acceptance are distinguished.
- Settings, privacy/attachment choices and request recovery move to on-demand sheets/detail. Exact approval target/operation/digest information remains available before decisions. No authority or receipt validation is weakened.
- Work uses real goal summaries and human state badges; immutable identifiers/revisions live in disclosures in the work detail. No fabricated activity, metrics or success indicators.
- Pairing, call controls and honest unavailable-call states follow the same native tokens. Added an original vector Ghost mark and reproducible opaque 1024px app icon.
- Idle foreground conversation inspection runs every8seconds; active work every2seconds. Scene/authority changes cancel the observation task. Manual inspection is one page, avoiding an additional indefinite polling loop.
- Drafts remain editable locally while offline or awaiting a receipt, provided the exact authority/target and draft storage are valid. Sending still requires the original online, recovery, pending-request and mutation guards. Sending never silently replays an unknown request.
- Native SF/Dynamic Type, dark mode, accessible labels and minimum44pt controls. At accessibility text sizes icons stay inside their hit areas, the input placeholder is shortened and the scope moves to the field's accessibility hint/options instead of consuming the viewport.

## Verification and evidence

Evidence directory: `ghost/.build/mobile-redesign-20261017-evidence/`. Core log: `.build/ios-redesign-core-tests.log`.

- Swift package tests:51passed. Authentication, pairing, scoped transport, journal/draft and voice-fence tests retain their existing contracts.
- Initial UI suite:6passed (legacy4, conversation-first2), preserved in `UI.xcresult`. Covers per-conversation drafts/relaunch, earlier reading/new arrivals, tabs/settings/options, empty and truthful unavailable voice.
- Compact device follow-up:2passed in `Compact2.xcresult`, including maximum accessibility type and actual repeated canonical-page observations receiving a new message without moving earlier reading.
- Final mobile follow-up:4passed in `FinalMobile.xcresult` after the accessibility icon/layout fix.
- Native width follow-up:1passed with a finalized `ResponsiveFinal.xcresult` and8screenshots. All320/375/414/768 layouts were visually reviewed; compact native size class is applied below600pt in the Debug-only iPad preview harness.
- The first native width test completed all assertions at320/375/414/768 but Xcode stalled while finalizing its result bundle; its incomplete `Responsive.xcresult` is not a successful finalized bundle. Retained log and later screenshots/re-run are separate evidence. A native size-class override is required for narrow iPad-hosted layout previews; it is Debug-only.
- Semantic foreground contrast pairs calculated in `contrast.json`: minimum4.96:1 across light/dark ink, secondary, accent, warning and panel backgrounds; inverse buttons also pass4.5:1. Native placeholder/disabled chrome follows platform accessibility behaviour.

## Device and limits

Updated the same physical iPhone14 app, bundle`io.a7garden.ghost.local`, team`W5SAS95CBV`, build2. Install/update preserves its existing data and Keychain; neither app nor canary was uninstalled and no connection key was read or replaced. Signed device build and actual install/launch receipts are in the evidence directory. The owner had already confirmed the paired conversation screen before this redesign; no new human confirmation of post-update UI or production message send is implied.

This is a native interface update, not new voice/APNs acceptance. The current local development profile has no APS entitlement; real remote push, microphone/speaker/background/cellular voice acceptance remain separate. There is no new server deployment or model-service restart in this redesign.

## Preservation and rollback

Original dirty sources were retained before editing under `.build/mobile-redesign-20261017-before/`; the generated project was also copied before regeneration. No production files or routes were deleted. Restore only the selected UI files from that snapshot if required; do not reset the repository's unrelated existing work. Rebuild/install under the same bundle identifier to keep the phone connection.

Final distinct tests: Swift core51 and UI9 (legacy4, new native5), with reruns recorded separately. `FinalMobile.xcresult` and `ResponsiveFinal.xcresult` both finalized successfully. Source-level whitespace checks pass. Xcode's existing AppIntents metadata-skip and iPad orientation warnings are not build errors.

Final machine-readable receipt: `.build/mobile-redesign-20261017-evidence/verification-summary.json`. Actual signed build2 install/launch succeeded after the last source update. All8existing services remain running; the protected HTTPS bootstrap returns401 with normal certificate verification.
