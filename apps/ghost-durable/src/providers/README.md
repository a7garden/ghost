# Ghost inference transports

Ghost owns selection, disclosure and current Host authority. Pi AI 1.1.0 supplies
serialization, streaming and tool-call normalization; these adapters have no
independent planner, tools, worker identity, scheduler or inference fallback.

`registered-models.js` preserves the Host's registered provider/model/effort.

- `zai-coding` uses Pi's native `openAIResponsesApi` at the existing
  `https://api.z.ai/api/v1/responses` profile.
- `minimax` uses the same native API at the existing
  `https://api.minimax.io/v1/responses` profile.
- Their keys remain in the existing owner-only Host credential files. Ambient
  environment keys and SDK credential stores are not used. Every request pins
  endpoint, model, effort, output budget and current authority. Response headers,
  stream chunks and the final executable result are checked again. Personal
  memory and document tools remain withheld on external routes.
- `codex` retains the official Codex CLI as a compatibility **model transport**,
  with its native tools/MCP disabled and structured tool-call results returned
  to Ghost's existing Pi engine. This is not direct Pi OAuth. Pi's built-in
  `openaiCodexProvider` requires its own OAuth credentials and uses a different
  direct backend. Ghost does not extract Codex `auth.json`, migrate tokens,
  initiate new login/consent, or write global credentials.
- `ghost-local` remains the explicit, loopback-only Dyno route in `models.js`.

The built-in Pi ZAI and MiniMax provider factories declare different endpoints
and APIs; this implementation deliberately uses thin existing Ghost profiles
around Pi's native Responses API. Moving to those built-in profiles requires
an explicit profile migration and provider capability verification.

The concrete OMP inference process transport is removed. The old exported
invoker fails closed. The injectable broker adapter remains for deterministic
legacy protocol fixtures; production startup does not select it.

`native-provider.test.js` verifies offline protocol fixtures, including native
tool-call/result replay, disclosure/selection/authority revocation, cancellation,
credential boundaries and no retries/substitution. These fixtures do not prove
live model access or provider tool support. No external provider calls were
made during this implementation; live A27 acceptance remains outstanding.

`startup-provider.test.js` additionally runs the production JSONL entrypoint in
broker mode with OMP import resolution rejected, no Codex/OMP executable or PATH,
and subprocess model transports forbidden. A real fixture Host authenticates
bootstrap and scoped callbacks; external inference is replaced with synthetic
native protocol frames. Credential/consent failures are typed admission errors
that become terminal `failed`/`admission_blocked` turns. Restart and same-ID
replay retain that outcome, while a later eligible turn can proceed without
replaying the blocked prompt. No production Host state is involved.
