# 0001 Desktop host lives in apps/ghost-desktop

Status: accepted, 2026-11-06. Rule: `stack.desktop`.

## Decision

`apps/ghost-ui` is the React console only. Its Tauri 2 host is the sibling project
`apps/ghost-desktop`, which packages this console's `dist`, the Ghost Host binary,
the Node console supervisor and the local voice launcher into one app bundle
(`apps/ghost-desktop/scripts/prepare.mjs`). The same console also runs in a browser
(`scripts/console.mjs`) and in the iOS preview shell, so it cannot carry a
`src-tauri` of its own without duplicating the native host.

## Replacement behavior

- Native window, overlay titlebar (macOS traffic lights at the Garden inset) and
  supervisor lifecycle are owned by `apps/ghost-desktop/src-tauri`.
- The console renders `GAppShell` with `macOSInset` only inside the macOS Tauri window.
- Garden's desktop native configuration checks apply to `apps/ghost-desktop`, not here.

## Verification

`garden doctor apps/ghost-ui` reports this exception. The packaged app is built with
`apps/ghost-desktop` (`npm run build`) and checked with its `--desktop-probe` and a
running-window screenshot.
