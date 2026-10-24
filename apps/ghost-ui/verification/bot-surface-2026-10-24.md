# Bot surface source acceptance — 2026-10-24

The existing Lifetime conversation now reads `bot.surface.inspect` for its exact
selected Ghost/conversation. The Host supplies the scoped roster, creation and
update operations, current readiness, immutable definition reference, and
nullable `lifecycle_expected_revision`. The UI does not call global discovery or
derive readiness from a model reply or the presence of a profile.

The existing creation entry opens the primary conversation with the supported
`이걸 봇으로 만들어 줘` draft. The Owner sends it explicitly. This is the
source-backed current-task creation path; it is not a general purpose setup
wizard or a grant editor. No schedule is added. With `VITE_GHOST_LIFETIME=true`,
live Ghost links enter this same conversation surface, so new bots use embedded
Pi and do not enter the legacy persona/OMP editor. The legacy and demo paths
remain available when the Lifetime feature is off. In Lifetime mode, the explicit
`/ghosts/<original UUID>?history=1&conversation=<original ID>` route preserves
read-only legacy transcripts and recorded outputs. Its entry remains available
even when the profile has no Lifetime registry target; it contains no legacy
submission, creation or policy editor controls.

Selected bot details expose purpose, capabilities, input/output contracts,
definition reference, update, clone, pause/resume and retire. Mutations use the
existing persistent Owner command journal. Update/clone carry the original
definition reference; lifecycle changes carry the exact returned nullable CAS
revision. The UI does not copy memory, conversations, credentials or grant fields.
After update/clone admission it selects the source bot's own conversation, where
the Host's scoped operation status is available. No optimistic readiness or mode
change is applied.

## Verification executed

- `npm test`: 193 Vitest tests and 13 authenticated bridge tests passed.
- `npm run build`: passed. Existing bundle-size advisory remains.
- Ten new tests cover cold failed-state rendering, mismatched selected pair or
  definition identity, duplicate rows, failed/current-unavailable readiness,
  immutable definition/CAS fields without capability expansion, read-only
  inspection, stale lifecycle rejection, lost clone receipt reconciliation after
  restart, and two new input commands addressed to one bot with distinct command
  identities, and original legacy transcript access after direct URL/cold render
  without a registry target or active legacy controls. These are UI/client fixture
  checks, not model execution acceptance.
- Existing-file changes were compared against copies of the initial dirty
  working files; no unrelated UI/iOS changes were reverted. Initial tracked
  source hashes matched the parent's baseline before editing.

## Browser fixture and remaining boundary

Run `node scripts/bot-ui-fixture.mjs`, then open the printed loopback URL. It
mounts the production App and Lifetime client with an isolated browser-storage
transport. It never discovers a Host, model, credentials or a production store.
The visible fixture controls change evaluation state or advance the Host-side
revision. The first clone call deliberately loses its acknowledgement after
saving a receipt; reload and inspect that original pending command, then verify
the displayed operation count has not increased. The fixture can also exercise
two inputs, pause/resume, retirement and failed-state restoration.

Interactive browser acceptance was not completed in this session: the CUA
browser inventory was empty; native Chrome binding and Safari input/observation
timed out before a fixture tab could be verified. Static rendering, client tests
and build success do not establish a visual or click-through pass.

Gateway/mobile bot method allowlists are unchanged. A paired device's exact
Ghost/conversation scope must be verified before any future bot status or
management methods are exposed; a new bot does not inherit that device grant.
This source change is not installed UI rollout or full B7 acceptance.
