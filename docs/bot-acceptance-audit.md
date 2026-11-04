# Bot acceptance audit — 2026-10-24

This records source evidence, not installed-state acceptance. The B4/lifecycle
suite independently passed 19 tests, with one opt-in live test excluded. The
previous live uppercase canary passed actual local inference and publication;
it is not the product-comparison scenario.

| Case | Existing executable evidence | Remaining acceptance |
| --- | --- | --- |
| A01 | The synthetic schema14 preservation fixture calls public Host startup twice through schema16. It preserves four registered persistent Ghosts plus one legacy profile, all five original histories/homes and four Works (one definition-pinned, three pre-B1), with zero replacement primary/default identities. Exact parent test passed1/1 in0.37s (`a01-parent-preservation.log`); source `src/host/preservation_tests.rs` and `.infra-snapshots/a01-preservation/manifest.json` retain the fixture contract. | Synthetic preservation is verified. Installed-data migration and operational cutover are separate unaccepted gates; this fixture performs no model inference. Do not recreate this already-passing fixture as missing work. |
| A02 | Actual-thread concurrent prepare/evaluate deliveries for one authenticated Owner turn, actual Pi ensure response withheld from Host, same-store Pi restart, cold Host/profile/route reopen, replay and duplicate ACK passed. Exactly one candidate/operation/Ghost/profile/conversation/evaluation Work/execution/acceptance/runtime-ensure delivery remains. Stable receiver command identity and exact durable Host receipt are checked. | Controlled disposable integration with Pi fixture mode and controlled evaluation; no external model or live service crash was exercised. Receiver ensure re-inspects its stable conversation rather than persisting its response bytes. |
| A03 | Returned protocol failures and prerequisites are classified by the current driver. Genuine subprocess death after profile creation and complete environment creation proves cold reopen, retained original phase and same-operation reconciliation. An additional death after registry/home commit but before Host route insertion proves one unchanged home, zero route/activation/ensure, typed reconcile_required on exact replay and a distinct explicit retry, and a second cold reopen. Premature activation creates no effects. The focused three-case suite passed. Earlier real Pi ACK and atomic activation-pointer tests remain. | Not every external-I/O boundary has genuine process-death coverage. The registry/Host split window safely remains reconcile_required; this test does not implement route repair. Full crash coverage and installed recovery remain unaccepted. |
| A04 | Generic JSON compute prerequisite is verified with a genuine Owner-accepted Python profile, two distinct nested inputs, independent unchanged verifier and cold pin preservation. Actual A04 now installs that private profile before admission and checks six execution roles. Two subsequent profile trials `190508-079ba27f` and `192627-af7ab698` both terminated failed at the historical120s settlement bound. The first published an offline-matching result without completion/Host acceptance; the second command exited1 with `KeyError: content`. | No ready bot, two new automatic reuses, correction or integrated restart is accepted. A separate functional observer preserves one original SDK wait and existing authority/oracle/budgets; it does not retroactively pass the old benchmark. Final independent review is clear after callback-cap/frame and checkpoint-schema corrections. Parent Node224/224, controller19/19, Rust functional bridge4/4, legacy bridge3/3 and full Rust430/430 (30 ignored) passed;13719 source/runtime/input files stayed stable. Distinct fenced functional trial `201702-e7ebf3ac` is terminal failed101/240.71s: seed accepted, evaluation response truncated at626 output tokens after14811 prompt tokens, no ready candidate. All24 calls had usage; source fence stayed clean. No retry is authorized. Evidence: infra `.verification/pi-engine-implementation-20261024/functional-observation/` and the two immutable profile attempt directories. Earlier distinct post-source-contract trial `220713-eec6e064` is terminal failed101/242.63s (controller247.008s): approved source/input/runtime stayed unchanged and parent verified original worker42798/test42801 missing. Seed accepted with seven effects, ready candidates0 and evaluation Works0;31 calls, last HTTP500 and one elapsed observation window. These observations do not establish root cause. Normal-RO corroboration confirms14 actual SDK schema rejections before Host because source_work_ids encoded an array as a string; the valid source ref was present. Both compactions completed; the final HTTP500 backend cause remains unknown. At that failure checkpoint the generic scalar-ref correction was unverified; subsequent source checks and the post-scalar trial are recorded below. Bot creation/two reuses/correction/restart and whole A04 acceptance remain pending. Diagnosis: [current normal-RO addendum](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T220713-eec6e064/a04-source-contract-normal-ro-corroboration.json); original limited-access diagnosis remains preserved. Evidence: infra attempt `a04-product-functional-20261024T220713-eec6e064/{result.json,state.json,live.log,parent-terminal-summary.json}`. |
| A05 | Ready metadata/filtering/no-fit, current native availability, model registry inspection and delegation tools exist. | Actual semantic selection among ready bots and explicit selection have not been demonstrated for the created product bot. The cross-Ghost canary uses an Owner-sealed fixed target. |
| A06 / A25 | Retained physical local Pi collaboration test passed1/1 in146.41s with a clean source fence: two acceptances,18 model calls, child and separate parent execution/effects, cold restart and zero worker outbox. Evidence: infra `.verification/pi-engine-implementation-20261024/b7/corrected-same-generation-wait-20261024T073121Z-04346277/{live.log,result.json}`. | Bounded fixed-target collaboration is verified. Natural A04-created bot selection/reuse, broader B7 scenarios and installed service behavior remain separate. |
| A15 | Real evaluation precedes same-ID update CAS; old Work keeps old bytes; identical concurrent updates cannot poison asset lookup. Clone gets one new identity without credentials/private history. Pause blocks new/queued starts while bound Work finishes; retirement retains results and rejects ordinary resume. | These Host boundaries are tested. Live-model lifecycle quality and actual UI interaction remain separate evidence. Conversational correction is not blanket definition-update authority. B5 additionally specifies old-plus-new regression corpus and validated rollback; those are not implied by the A15 table alone. |
| A11 / A17 | Current source-built native Oxibrain and the frozen Ghost test binary passed `real_oxibrain_documents_reconcile_without_episode_or_assertion_promotion`1/1 in102.03s. Actual accepted Work experience matched its PDC page/hash and fresh native index; episodes/assertions remained0. Evidence: infra `functional-observation/a17-native-index-lifecycle-before-fix.log`. | One-Ghost native document indexing is verified. The suspected session-lifecycle defect was not reproduced, so no speculative fix was applied. Bounded two-authenticated-client native retain proof now passed1/1 in13.57s: two genuine typed lock refusals, exact original-envelope retry, actual commit/ACK loss, scoped URI reconciliation and exactly two episodes/four ingest submissions (two precommit refusals plus two commits), with all children reaped. Evidence: infra `a17/native-outcomes-v5/parent-verified.json`. PDC indexing concurrency, actual SDK memory flow and full A17 remain separate. |
| A18 / B6 | Actual native normal-retain publication, receiver reconciliation, restore and revoked-origin withdrawal test passed1/1 in4.99s (`b6-native-correction-closure-parent.log`). Earlier missing publication/receipt-bridge claims are superseded by this bounded composite. | Controlled native closure is verified; live-model collaboration, the whole memory adversarial matrix and installed migration are not implied. Publication-derived experience indexing remains deliberately blocked. |
| A19 | Controlled native Oxi/PDC distinct-root restore with actual production Pi SDK, real Host HTTP and existing driver passed (`a19-native-sdk-20261024T130646Z-07b9a24f`, 254.73s). Original roots quarantined; genuine parked old SDK context freshly denied at epoch2 with zero inference/effect/claim deltas; explicitly adopted new Work accepted under the same Ghost. Original checkpoints, context/claims, effect receipts, definitions, memory/source/artifact/home identity and second cold reopen checked. Exact restored lease pair reconciled through explicit owned release receipts; source reservations retained. | Uses controlled loopback inference and declared fixture computer. Physical/operator restore, external model quality and installed-state cutover remain pending. Same-epoch Work recovery tests do not prove every queued Owner report was delivered. |
| A20 | Corrected clean single-bot trial passed6/6 semantic fields, five calls,35,576 input/1,756 output tokens,49,456ms, one report and zero Owner mediation (`a20/clean-corrected-single-4096-20261024T064842Z-5fec5d19/trial-report/result.json`). | Initial paired batch failed0/3 in both lanes (`a20/first-batch-v1/summary.json`). No valid paired quality/cost comparison or comparative p50/p95 is established. Measured self-host resource cost remains unknown. Do not present the single trial as a collaboration improvement. |

Source anchors: `src/host/mod.rs` startup compatibility;
`src/host/bots_store.rs` identity and Work pins;
`src/host/bots_provisioning.rs` creation/provisioning and its driver;
`src/host/bots_provisioning_live_tests.rs` the uppercase canary;
`src/host/bots_lifecycle_tests.rs` lifecycle and current-authority tests;
`src/host/lifetime_computers.rs` production dynamic route restoration;
`apps/ghost-durable/src/runtime.js` model choice tools/policy;
`src/host/lifetime/delegation_contracts.rs` fixed-target Owner contracts.

The target-free immutable Owner task contract prerequisite is now implemented in
`src/host/lifetime/task_contracts.rs`; it binds authenticated task input and
eligible definitions without granting model-authored Owner authority. Unconfigured
chat still requires independent review. An earlier A04 attempt passed the original
comparison's independent verifier but failed at the actual Pi report-reply gate.
A stale idle-barrier race in the test driver was reproduced and fixed (3 focused
bridge regressions passed); the updated full local-model scenario remained pending
at that checkpoint. The earlier HTTP 500 was real; the exact later admission
failure was unknown in that observation.
A subsequent frozen run (`a04-product-corrected-20261024T133152-47023f29`)
reached the 120s drain cap with a running Work and no accepted artifact: the
producer assumed unavailable interpreters/modules and writable `/tmp`, while the
Owner repeated a malformed-ID compatibility admission. Host automatic-admission
metadata and the normal model action inventory have been corrected; focused Host
recovery tests, Node165/165 and Rust393/393 (24 opt-in ignored) passed. Historical
pending model-handler admission is now fenced before transport, with retained SDK
crash/reopen and effect-preservation tests; Node166/166 passed. Full A04 remains
unaccepted. Work inspection now exposes configured producer policy (including
readonly root and writable /workspace) from actual argv constants, with explicit
fixture labeling and no package-inventory claims. Focused environment tests6/6
and Rust397/397 (24 opt-in ignored) passed at that checkpoint. The subsequent
`a04-product-corrected-20261024T140344-36a9eb63` trial produced no Goal/Work and
unrelated advisory text, so A04 remains failed. New final-projection guards require
exact current selected-task admission, retain failed SDK answers without advisory
projection, and preserve ordinary chat and queued acknowledgements. Node167/167
and focused Host admission checks passed; this honesty boundary does not prove
that the model performs the selected task.
The producer guidance change preserves task data, verifier and capability grants;
its Node regression suite passed 165 tests. This is not full A04 acceptance.

Next work is the demonstrated P2 status-observation conflict, then the actual A04
comparison vertical using the shared fixed realistic corpus and Owner contract,
and remaining provisioning crash boundaries. The four-Ghost plus legacy profile
synthetic preservation fixture already passed; installed migration remains a
separate operational gate.

Earlier 2026-10-25 checkpoint: selected-task runtime admission and authenticated narrow
Owner inspect/reconcile routes now exist. Node182/182, Host operator6/6, actual
production-SDK controlled recovery1/1 and full Rust408/408 (25 ignored) passed.
The actual fixture proves original callback/receiver receipt recovery through
owned Pi restart, not completion of the interrupted Owner generation. A real P2
gap was exposed: a later effect_unknown observation carrying the original SDK
submission conflicts with an earlier immutable null-submission observation
because that report identity was only turn/status. Existing evidence was
preserved; no live pointer or completion was fabricated. A04 local-model
execution, natural bot creation/reuse and broad P1–P3 gates remain unaccepted.

The subsequent frozen P2 fix now records append-only predecessor-bound status
observations, exact Host command receipt corroboration and legacy preservation.
Cold SDK cancellation drains only a freshly proven singleton original task/input;
unrelated tasks/queued inputs remain paused. New cancel ACKs include bounded
scope headers; an actual stale lookup/terminal race was reproduced and fixed
with an exact dual-SID read-only observation. Parent Node198/198 (7.805s),
authenticated actual Host/SDK1/1 (8.68s) and Rust408/408 (25 ignored,100.51s)
passed; independent review found no material issue. The actual test now checks
the original cancel outbox ACK/receipt and original SDK aborted generation,
without changing background Work receipts. The controlled Work in that fixture
is independently unverified, so this is not report quality, inference resume,
full P2 or A04 acceptance. Historical scope-incomplete cached responses are not
silently rewritten. See infra `plans/2026-10-25-ghost-turn-status-observations.md`.

The requested AgentStatus product component now projects exact selected-pair
ConversationRun/Work/Goal states with Host clocks and existing inspect/cancel
actions. Final UI236 Vitest +13 bridge tests and build passed; explicit synthetic
browser fixtures verified nine states, responsive light/dark layout, focus and
reduced motion. B8 saved login/card/contact reuse is a documented additional
goal, with secure broker/origin/observation requirements; it is not implemented.
See infra `plans/2026-10-25-ghost-private-vault-and-status-ui.md` and
`reports/2026-10-24/ghost-pi-bot-integration-progress.md` for evidence boundaries.

### 2026-10-25 scalar-ref and retirement source checkpoint

The subsequent scalar `source_contract_ref` correction passed bounded source checks: Host derives the exact original source Work, the registered legacy schema is preserved, and only the model-wire copy is narrowed for the selected path. Focused Rust passed7/7; full Node230/230 passed7.661s, including three TypeScript retirement traps, and full Rust460/460 passed106.52s with31 ignored. The cold ABI test is a controlled SDK fixture with explicit test-owned resume; production cold Owner inference stays paused. Both its initial failure and corrected3/3 fixture logs remain in infra `native-outcomes/scalar-source-ref-node-abi-bound{,-corrected}-focused.log`.

Public `GuestModelBroker::start` retires before authorization/configuration/filesystem/thread effects, and TypeScript public CLI/export paths retire before input/auth/OMP import. Public production-retirement tests passed5/5 in0.17s. Independent review confirmed the exact original thirteen assertions remain in the private `cfg(test)` fixture. This is source retirement evidence; environment/operator cleanup, installed P3 transition and remaining cutover acceptance are pending.

The13730-file fence stayed clean before/after the final build. Approval `d68d01d7f43f38e4e42ec190cb40de2a86a20171b9902d5f9ee5fc708f5942ea` binds binary `4ba0f0d601491c1cf8aa4e571d9993cfdfa23e71ca4e3e9aa29b4d0d1691f4c9`. Exactly one new post-scalar A04 trial `223450-108d7c56` was launched with original worker53670/test53673 recorded running at launch. Actual bot creation/reuse/correction/restart remains unaccepted. The same original attempt is observed without automatic retry; no open SDK/DB inspection was performed for this update. Earlier failed trials remain failed, and the overall goal remains incomplete.

The original `223450-108d7c56` subsequently terminated failed101/218.71s (controller223.106025s), superseding that launch status. Source/input/runtime stayed unchanged, secondary errors are empty and parent verified original53670/53673 missing; no automatic retry or test/worker kill is recorded. Seed accepted with seven effects; candidate creation/evaluation admission was reached, but the evaluation Work remained running with four effects. Candidate acceptance, ready bot, reuse/correction/restart remain unproved. Metrics:26 calls,223177 known prompt/5269 completion tokens, one missing usage; final call26 returned131 tokens at prompt15626 with `finish_reason=length`/`output_truncated`. The separate earlier HTTP500 cause and the overall failure mechanism remain under diagnosis. `windows_elapsed=0`. Evidence: infra attempt `a04-product-functional-20261024T223450-108d7c56/{result.json,state.json,live.log,parent-terminal-summary.json}`. Source checks above remain bounded source proof; actual A04 and the overall goal remain incomplete.

The subsequent [read-only diagnosis](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T223450-108d7c56/a04-post-scalar-readonly-diagnosis.json), SHA`fdbe96208a0a5c0d50683a5b97a6ea00dd61e4065fa1ae4782020ec6ae6cc3c9`, and independent parent normal-RO corroboration confirm scalar prepare/evaluate/activate each succeeded once at Host. Activation remained an evaluating-state request, not readiness. The actual4317B program dynamically `json.load`ed the complete pinned4602B input without hardcoded product IDs. The physical4132B output, SHA`a1e57f6cb002a8e69d71a3449a1d466be436859f79807eec689934cedb433525`, matches candidate/case identities; both outputs equal withheld fixtures in an offline diagnostic comparison only. This is not publication, independent evaluation acceptance or Host acceptance.

The complete raw output readback grew the prompt13257→15626; the final allowance/completion was131 tokens with length/truncation before `publish_artifact` or `execution.complete`. The earlier HTTP500 remains a separate backend failure with unknown cause. The failed trial, source fence and original evidence remain unchanged. An explicit opt-in `read(view:'json_summary')` correction is approved and in progress, requiring bounded full parsing/exact declared schemas within the existing read grant while preserving raw reads, old receipts, independent verification, caps and privacy. Its implementation and tests are not established at this checkpoint. This documentation-only addition ran no SDK/DB, build, test, model or native operation. A04, reuse/correction/restart and the overall goal remain incomplete.

### 2026-10-25 optional JSON summary source checkpoint

Explicit [JSON read summaries](pi-direct-execution.md#optional-json-read-summary) are implemented in eight frozen production files with clear independent review. They use the existing read grant/effect scope and complete bounded UTF-8 snapshot/digest before line normalization (64 KiB input;1536B summary; eight shape entries;48B keys/96B paths). Full parsing and exact pinned Owner output schemas, or verified original evaluation/candidate/case identities and candidate source output schemas, emit no expected answers, verifier code or raw scalar values. Known parse/schema failures complete the read receipt with an error rather than an unknown-effect fence. Default text reads, old receipts, original Goal rendering/input pins, caps, history and authority/privacy fences remain; cancellation/tamper guards still apply before replay delivery.

Parent corrected focused Rust passed7/7 in0.69s; the initial two negative-helper unwrap failures and default-feature zero-test run remain retained, not validation. Focused Node passed10/10 in0.291s, including controlled SDK summary-to-publication-request wire proof with fixture bytes/token estimate below half raw readback. Full Node passed234/234 in7.9549s. Full Rust is running, with no pass yet claimed. This is bounded source/controlled-fixture proof, not actual model, native end-to-end, cost or benchmark acceptance.

The fully awaited v2 pre-final-build snapshot has13732 files and SHA`860acee953406cc54c34e65e683dbf35b09edd55721ead1c1c0b0bea98628d91`; infra retains `native-outcomes/approved-json-summary-v2-before-final-build.json` and all `json-summary-*.log` proof, including initial failures. The overlapping provisional v1 capture is not final approval. No further model trial has run. Actual `223450-108d7c56` remains failed, and A04/reuse/correction/restart, native/model end-to-end acceptance and the overall goal remain incomplete. This checkpoint is documentation only; no source/controller/test/runtime edit or test/build/SDK/DB/model/native execution was performed for it.

### 2026-10-25 final source checks and latest actual terminal

Parent final full Rust passed467/467 with31 ignored in108.33s, alongside full Node234/234 in7.9549s. The approved v2 source fence of13732 files stayed clean after the final build. This supersedes the pending-full-Rust checkpoint while preserving initial failures and zero-test evidence as history; source proof does not establish actual model or end-to-end native acceptance.

Exactly one subsequent original trial, `a04-product-functional-20261024T230854-6fea080d`, terminated failed101/147.28s (controller151.694473s). Error: seed Work `01a1702c-c7c1-7586-8b88-f38d24d7cb68` was still running and independently unaccepted, with nine effects. No seed acceptance, candidate creation or evaluation was reached. Source/input/runtime stayed unchanged, secondary errors are empty and parent verified original worker65397/test65400 missing; no automatic retry or test/worker kill is recorded. This terminal status supersedes launch observations. Evidence: [original result](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T230854-6fea080d/result.json), [state](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T230854-6fea080d/state.json), [live log](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T230854-6fea080d/live.log) and new [parent summary](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T230854-6fea080d/parent-terminal-summary.json).

All14 calls have usage (135612 prompt/3907 completion tokens). Final HTTP200 used prompt16259 and requested/completed39 output tokens, ending length/truncated; there was no HTTP500. Parent normal-RO metadata confirms no `json_summary` call occurred before this failure. Two3401B input reads,4101B write/374B edit,4151B rewrite/129B edit and two known bash errors preceded bash success with2490B stdout; old program/input observations remained in context. Exact-cause read-only diagnosis is pending, and this run does not validate or demonstrate a failure in JSON summary. No new code or trial is authorized at this checkpoint. This documentation-only update opens no SDK/DB and runs no test/build/model/native operation. A04/reuse/correction/restart and the overall active goal remain incomplete.

The subsequent [normal-RO seed diagnosis](../../infra/.verification/pi-engine-implementation-20261024/a04-product-functional-20261024T230854-6fea080d/a04-seed-recovery-readonly-diagnosis.json), SHA`9eeccedfa215cb456208da63e02c9b84b5f1a290834ccee5300a5e2639559159`, preserves originals and confirms two recovered `KeyError`s: flat `product_id` and `ref` assumptions were corrected to nested `source` metadata. Final bash exited0; all nine effects are complete without an unknown-effect fence. Its1440B answer SHA`7b57a792f871419f040f533be6a448a5edf37969fda7e45a24a8420122d9aaa0` equals the prior `223450-108d7c56` independently accepted seed bytes under identical input digest, Owner template content digest, verifier and input/output schemas. Different scoped template IDs are normal across Ghost scopes. This diagnostic equality does not accept the current seed: no publication or current acceptance occurred, so the latest trial remains failed.

Raw-content diagnosis records3828B/3869B full program writes, a duplicated2154B input read and1471B final full JSON stdout; these are distinct from the earlier transport byte counts. Old program/input observations, errors and raw receipts remained in context before the16259-token prompt/39-token truncation. Output read and `json_summary` were never reached; no HTTP500 caused this failure. The next deterministic completed file-action pair projection is design-only under independent review, with no implementation or further trial authorized. Existing467/467 Rust and234/234 Node source gates remain the last verified checks; all source stays frozen. This documentation-only addition performs no SDK/DB, build/test, model/native or runtime operation. Actual A04 and the overall active goal remain incomplete.
