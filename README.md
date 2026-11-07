# Ghost

Durable Ghosts you hand work to. One Bun process keeps every Ghost's conversations, the Work you hand over (맡긴 일), owner decisions and effect receipts, and serves the Mac app, the web UI and the iPhone.

[Architecture](docs/architecture.md) · [Current goals](docs/current-priorities.md) · [Local operations](docs/local-operations.md)

## Layout

| Path | What |
| --- | --- |
| `apps/ghost-host` | the host process (`ghost serve`, `ghost import`, `ghost backup`, `ghost doctor`) |
| `packages/ghost-contract` | API schemas and types shared by host and clients |
| `apps/ghost-ui` | web UI, served by the host |
| `apps/ghost-desktop` | Tauri Mac app around the host and UI |
| `apps/ghost-ios` | iPhone app |
| `apps/ghost-voice-server` | local voice server (follow-up scope) |

## Develop

```sh
bun install
bun run test
bun run typecheck

# a throwaway host
export GHOST_ROOT=$(mktemp -d)
bun apps/ghost-host/src/main.ts serve
cat "$GHOST_ROOT/host.json"          # port and owner token

# UI against it
(cd apps/ghost-ui && bun install && bun run dev)
```

Never point a development host at `~/Library/Application Support/Ghost`; that is the production state root.
