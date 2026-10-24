import { ProtocolError } from "./contract.js";

export function validateBotRepairDescriptor(value, reportId) {
  if (value === undefined || value === null) return null;
  const fields = ["report_id", "candidate_id", "candidate_digest", "candidate_revision", "repairs_remaining"];
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(field => !Object.hasOwn(value, field)) || value.report_id !== reportId
    || typeof value.candidate_id !== "string" || value.candidate_id.length < 1 || value.candidate_id.length > 400
    || typeof value.candidate_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.candidate_digest)
    || !Number.isSafeInteger(value.candidate_revision) || value.candidate_revision < 1 || value.candidate_revision > 2
    || value.repairs_remaining !== 3 - value.candidate_revision) {
    throw new ProtocolError("bot_repair_descriptor_invalid", "Host report repair capability has invalid identity or bounds.", "never");
  }
  return { ...value };
}

export function matchesBotRepair(descriptor, args) {
  return descriptor !== null && args?.candidate_id === descriptor.candidate_id && args?.candidate_digest === descriptor.candidate_digest
    && typeof args.instructions === "string" && Buffer.byteLength(args.instructions, "utf8") > 0 && Buffer.byteLength(args.instructions, "utf8") <= 32768
    && Object.keys(args).length === 3;
}
