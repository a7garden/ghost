# Shared skill publication and evaluated adoption

Shared skills use explicit `common` and `project:<canonical UUID>` catalogue namespaces. A namespace is a name, not a read grant. Existing Ghost UUID skill references retain their previous interpretation.

The authenticated Owner publishes an exact existing skill archive revision with `skill.catalog.publish`:

```json
{"method":"skill.catalog.publish","namespace":"common","id":"procedure","source":{"namespace":"<source Ghost UUID>","id":"source-skill","revision":1,"digest":"<sha256>"}}
```

The command envelope supplies the current catalogue head revision as `expected_revision` (null for first publication). The source must be the exact active skill revision. The existing scoped file reader refuses traversal, symlinks, hardlinks and mutation during the archive read. The catalogue retains immutable source bytes, classification and provenance in the workspace journal. Publication does not alter any bot definition, alias or running Work.

`skill.catalog.inspect` takes an exact `reference` and returns provenance metadata. Reader grants use separate Owner CAS commands:

```json
{"method":"skill.catalog.grant","reference":{"namespace":"common","id":"procedure","revision":1,"digest":"<sha256>"},"ghost_id":"<reader Ghost UUID>","allow":true}
```

Each grant is specific to one Ghost and one immutable publication. `allow:false` revokes it. A changed grant revision fences prior Work even if a later command grants access again. Reauthorization never rewrites old Work lineage or deletes effect receipts.

An existing evaluated bot adopts with `bot.update.prepare`:

```json
{"method":"bot.update.prepare","ghost_id":"<target Ghost UUID>","definition_ref":{"ghost_id":"<target Ghost UUID>","revision":1,"digest":"<definition digest>"},"skill_adoption":{"reference":{"namespace":"common","id":"procedure","revision":1,"digest":"<sha256>"},"alias":"procedure"}}
```

This form is exclusive with the existing `instructions` update form. The Host requires explicit current grants for both the target Ghost and the actual evaluation Ghost before rendering candidate bytes. The alias and exact reference are part of the new definition digest; grant lineage is part of the candidate digest. Local names and unrelated shared aliases cannot be shadowed. The candidate preserves identity, conversation, contracts, memory reference and capabilities.

Adoption uses the existing independent evaluation, current resource readiness and activation CAS. The Host requires the Owner evaluation corpus to retain the previously accepted cases and add a distinct held-out input for changed skill adoption. Publication and preparation alone do not activate a definition. Rollback selects an exact previously accepted publication through the same staged path and the current evaluation corpus; it does not undo external effects or require inventing another input merely to rename old bytes.

Running Work retains its admitted definition, asset bytes, aliases and exact grant revisions. New Work pins the newly activated definition. Conversation history records exact shared references under its originating Ghost/conversation pair, including evaluation and receiving parent scopes. Revocation blocks later unbound inference and compaction through the same final provider guard. An explicit current regrant can authorize those identical history bytes; it does not replace the original Work grant revision. Revocation is checked before cached callback responses, assignment projection, final inference admission, effects and completion. Delegation requires an explicit target reader for every shared source dependency; accepted child output carries that source dependency back to an authorized parent. Admission persists shared-source disclosure before any inference or effect; later Owner history cannot send these protected bytes through a selected external route merely by omitting a Work pair. Private/local-only shared bytes require a local route, even if a Goal was submitted as public or an external provider has history consent. A historical evaluator grant is not an ongoing permission requirement for already active target Work; new evaluation and activation require current evaluator authority.

The catalogue and grants are Host control APIs. Models cannot publish or grant catalogue access. This implementation does not migrate installed data, replace local skill storage, or infer project membership permissions.

## Agent Orchestra guidance

Export the common contract, bounded worker guidance and selected domain flows as one local-only Ghost skill. See [Ghost Orchestra workflow](orchestra-workflow.md).

## Source-derived functionality still open

New Work snapshots current authorized retained references even when its Ghost has no selected definition. Original Work pins never widen during inference. New assignments carry a Host-sealed `ghost-work-context/1` descriptor, bound to the original canonical Ghost/conversation, assignment bytes, Work revisions, execution lineage and admission authority epoch. A trusted runtime binds one exact SDK generation/provider-session/storage tuple before invoking inference. Its outer `context_ref` is accepted only for explicitly scoped Work operations; inference requires the exact assignment/Work pair. An isolated v1 Work can continue after unrelated v2 Owner history, while current v1 grant revocation still blocks inference and cached effect disclosure. Owner history remains independently guarded; attaching a clean Work reference to an unbound Owner request does not bypass it. Contextless cancellation remains available under the existing owned Work/epoch checks without disclosing source history.

Context eligibility is sealed only in the original new-assignment transaction. Historical assignments and persisted unmapped generations are not backfilled or relabeled clean. Their mixed history remains fenced; safe request reconstruction or an explicit same-execution continuation is still open recovery functionality. Existing isolated claims reuse their original binding on same-epoch cold reopen; a new Host authority epoch fences the original context rather than silently reminting it. Work storage receipts are separate from the canonical Owner conversation locator. Exact terminal completion/effect receipts can be recovered under current authority and reader checks, while new terminal inference or effects remain denied. Host component tests establish these boundaries; they do not prove the full runtime/physical isolation path.

Supported delegation propagates exact Work references plus retained conversation references for legacy shared contexts, and verifies every target reader before child bytes are admitted. A claimed isolated context transfers its sealed Work dependencies; unrelated later Owner history does not widen that Work. Free-form mailbox, independent memory retention/session records, Work experience recording, document derivation, and model-created/repaired bots currently deny when shared history cannot preserve those dependencies. Safe metadata capability discovery remains available. Source-derived bot creation and experience retention are OPEN product functionality, requiring a later lineage-preserving candidate/profile integration; these denials are safety fences, not completion of those product requirements. Authenticated Owner catalogue/adoption operations remain explicit controls.
