# 0001 Desktop host lives in apps/ghost-desktop

Status: accepted, 2026-11-06; updated 2026-11-07 for the Bun host. Rule: `stack.desktop`.

## Decision

`apps/ghost-ui` is the React UI only. The Ghost host (`apps/ghost-host`) serves its built `dist` at `/`. Its Tauri 2 shell is the sibling project `apps/ghost-desktop`, which either attaches to a running host or bundles the compiled host binary and this `dist` (`apps/ghost-desktop/scripts/prepare.mjs`). The same UI also runs in a browser against any host, so it cannot carry a `src-tauri` of its own without duplicating the native shell.

## Replacement behavior

- Native window, overlay titlebar (macOS traffic lights at the Garden inset) and host supervision are owned by `apps/ghost-desktop/src-tauri`.
- The UI renders `GAppShell` with `macOSInset` only inside the macOS Tauri window.
- Garden's desktop native configuration checks apply to `apps/ghost-desktop`, not here.

## Verification

`garden doctor apps/ghost-ui` reports this exception. The packaged app is built with `apps/ghost-desktop` (`npm run build`) and checked with a running-window screenshot.
