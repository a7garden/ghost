# ADR-008 — embedded temporary loopback fixture UI

2026-10-02. This first UI unit connects multiple Ghost identities, mock conversation/independent tasks, results/errors/cancel and actual local browser ownership/epoch/handoff/resume on one compact screen. Explicit local fixture/MockProvider; no live LLM, actual human approval or v1 release claim. No login, credentials, publishing, auto-start or persistent access setting.

Embed static HTML/CSS/JS in the Rust CLI and serve only finite 127.0.0.1 listeners. No Node/Bun/Python product runtime. Optional actual browser uses the fixed OxiBrowser artifact. UI and untrusted HTML fixture have different ports/origins; the child sandbox permits only its fixture port and cannot reach the UI port. Never render a page body in an iframe or in the UI origin.

Fixed routes only, no filesystem document root. Exact Host/action Origin checks, memory-only random session cookie/CSRF token, HttpOnly/SameSite=Strict, bounded headers/body, duplicate headers/transfer encoding rejected, no CORS, frame-ancestors none, self-only script/connect CSP. No tokens in CLI arguments, DB, logs or visible screenshots. This is browser CSRF containment, not human authentication or isolation from same-user local processes.

Writer loop uses existing public submit/cancel/run/list/controller APIs. Background updates run independently of read requests. Read snapshots return cached immutable projections and never dispatch, grant or open a writer. A validated fixture HTTP session yields a private typed host action. Prompt/result/page strings remain text and never deserialize into actions or create buttons. Frontend uses textContent/DOM creation only. Stale context fails closed; IDs deduplicate; historical ACKs never render current ownership. scripts/network continue remains visible.

Create explicitly marked fixture profiles in a new root; refuse nonempty unmarked or symlinked roots. No user profile import or production lease dispatcher. Mock queue timing is labeled; no fake inference stream. UNKNOWN requires explicit fixture acknowledgement and never replay.

Verify real headless HTTP/security/core behavior plus existing110. Actual UI/render/screenshot evidence uses one temporary OS WebKit nonpersistent window, with no user browser/profile or desktop capture. Synthetic fixture events are not real human approval. Parent coordinates the game-task GUI/GPU slot first; until then source/build/headless work only. Browser repository remains read-only.
