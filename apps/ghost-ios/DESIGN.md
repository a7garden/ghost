# Ghost Mobile

The iPhone is another full way into Ghost, not a reduced client (owner decision,
2026-11-09). The app is a native shell around the Host-served web UI, so every surface
the Mac and browser show — conversations with interactive answers, mockups, charts,
images and files, Works, decisions, Spaces, Ghost settings, the vault — appears on the
phone the moment it ships on the desktop. Mobile layout, touch affordances and sheets
live in `apps/ghost-ui`; this app owns only what a web page cannot.

## What stays native

- **Pairing.** One decision: scan the QR the PC shows under 설정 › 기기 › 기기 연결,
  drawn as that path rather than a sentence. Typing the server and code is the fallback
  in a sheet (uppercase, spaces dropped, the address checked before the sheet closes).
  The phone names itself at claim; the name is editable before connecting. Connecting,
  an interrupted claim (send again unchanged or start over) and a failure each replace
  the action area instead of stacking warnings.
- **Credential.** The issued device token lives in the Keychain
  (`WhenUnlockedThisDeviceOnly`) and reaches the page only through a document-start
  script on the paired origin's main frame.
- **Notifications.** Permission, APNs registration, and push taps. A tap becomes a
  `notification.open` page event; the web UI routes it exactly as its inbox does.
- **The moments the page cannot draw.** Launch, first load and an unreachable Host
  (retry, or forget the connection). Launch and first load are one picture: the face from
  the app icon alone in the middle of the whole screen, no words and no progress widget; the
  wait is the face's own behaviour. The disc has a soft top-to-bottom gradient and a faint
  sheen (and in the dark a hairline of light on its top edge), the eyes are near-white, and a
  halo of the signal blue glows behind it. The launch screen is the canvas colour and
  `LaunchMark` (declared as `UILaunchScreen` in `App/Info.plist`, light and dark): the face
  asleep, with the icon's slit eyes. The first-load view (`GhostAwake`) starts on exactly that
  picture at the same size and place, then wakes: after 0.15 s the eyes spring open and the
  disc and halo lift a little and settle. While the page loads it looks for the PC: unhurried
  glances left and right (the eyes travel further than the mouth and the far eye narrows, as
  if the head turned under a fixed light, so the sheen and rim stay put), a blink at uneven
  intervals, and one slow breath every 4.2 s that swells the halo while the disc floats a
  point or two above it. The glances and blinks run on uneven ten- and twenty-second
  sequences that end where they begin, so a slow connection never shows a seam or looks hung.
  When the page says it is ready the face recognises it: the gaze comes to the centre, the eyes
  widen and the mouth turns into a small smile (0.3 s), then the mark swells, softens and fades
  as the page fades in just behind it. Reduce Motion moves nothing: the eyes open in place, the
  halo and the face breathe in brightness, recognition is only the smile, and the mark only
  fades out. The pairing screen shows the same face awake and breathing, mostly looking at the
  owner with a rare glance away; connecting looks for the PC like first load; an unreachable
  Host shows it asleep (slit eyes, no halo). Everything is drawn by `App/GhostMarkArt.swift`,
  which `scripts/render-launch-mark.swift` also compiles to render `LaunchMark`; run it again
  whenever that file or `GhostMark.launchSize` changes.

## Shell rules

- Only the paired origin loads in the shell. Sandboxed previews (`about:srcdoc`) stay
  inert inside it; every other top-level link opens outside the app, and a subframe can
  never navigate the owner away.
- Bridge requests are honored only from the paired origin's main frame; the request set
  is closed (see `Sources/GhostMobileCore/Shell.swift` and `apps/ghost-ui/src/host/shell.ts`).
- The page draws under the status bar and home indicator and handles safe areas and the
  keyboard itself: the shell shrinks the web view with the keyboard and the page reads that as
  keyboard-open (a focused text field in a shorter viewport). The system's ^ v ✓ accessory bar
  is removed (`PageWebView`); a downward drag outside the composer closes the keyboard. The
  native background and status bar follow the page's resolved theme so nothing flashes.
- Downloads go to the share sheet. `<input type=file>` uses the system photo, camera and
  files picker.
- Edge swipe goes back through the page's history.

## Capability

A paired phone acts as the owner except for device management: only the PC starts
pairing, renames devices, or revokes another device. The phone may revoke itself from
설정 › 기기. Revoking it on the PC is the control for a lost phone.

## Tokens

`GhostStyle` keeps only the neutral tokens the native surfaces need (canvas, surface,
ink, secondary, signal, danger), matching the web UI's light and dark values. Primary
actions use explicit ink/on-ink fills; hit targets are at least 44pt; Dynamic Type,
VoiceOver labels and Reduce Motion are honored.
