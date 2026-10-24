import { createHash } from "node:crypto";
import { ProtocolError } from "./contract.js";
const privacyRank = { public: 0, private: 1, local_only: 2 };
const text = (value, max = 400) => typeof value === "string" && value.length > 0 && value.length <= max;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

// The Host resolves same-graph accepted evidence and stages exact verified
// bytes. Only its deterministic Work-local paths are presented to the model.
export function validateWorkInputArtifacts(values = [], privacy) {
  if (!Array.isArray(values) || values.length > 128) throw new ProtocolError("work_input_artifacts_invalid", "Work input artifact metadata exceeds its bounded contract.");
  const paths = new Set();
  return values.map(value => {
    const artifact = value?.artifact;
    const path = `input-${createHash("sha256").update(typeof value?.work_id === "string" ? value.work_id : "").digest("hex")}-${artifact?.digest}`;
    if (!exact(value, ["work_id", "goal_id", "goal_revision", "execution_id", "path", "artifact"])
      || ![value.work_id, value.goal_id, value.execution_id].every(id => text(id))
      || !Number.isSafeInteger(value.goal_revision) || value.goal_revision < 1
      || !exact(artifact, ["digest", "locator", "privacy", "producing_attempt"])
      || typeof artifact.digest !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.digest)
      || !text(artifact.locator, 4096) || !text(artifact.producing_attempt)
      || !Object.hasOwn(privacyRank, artifact.privacy) || privacyRank[artifact.privacy] > privacyRank[privacy]
      || value.path !== path || paths.has(path)) {
      throw new ProtocolError("work_input_artifacts_invalid", "Host Work input metadata has invalid scope, digest, disclosure or staged path.");
    }
    paths.add(path);
    return { work_id: value.work_id, goal_id: value.goal_id, goal_revision: value.goal_revision, execution_id: value.execution_id,
      path, artifact: { digest: artifact.digest, locator: artifact.locator, privacy: artifact.privacy, producing_attempt: artifact.producing_attempt } };
  });
}
