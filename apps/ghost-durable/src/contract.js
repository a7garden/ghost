import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = "ghost-lifetime/1";
export const CONTRACT_REVISION = 1;

const ENVELOPE_FIELDS = new Set([
  "protocol_version",
  "command_id",
  "payload_digest",
  "actor_ref",
  "authority_epoch",
  "expected_revision",
  "correlation_id",
  "body",
]);

const METHODS = new Set([
  "conversation.ensure",
  "conversation.submit",
  "conversation.assignment",
  "conversation.inspect",
  "conversation.status",
  "conversation.steer",
  "conversation.cancel_turn",
  "runtime.reconcile",
]);

export class ProtocolError extends Error {
  constructor(code, message, retryClass = "never") {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.retryClass = retryClass;
  }
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ProtocolError("invalid_payload", "Payload numbers must be safe integers.");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort(compareUtf8)) {
      normalized[key] = normalizeJson(value[key]);
    }
    return normalized;
  }
  throw new ProtocolError("invalid_payload", "Payload is not strict JSON.");
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value));
}

export function payloadDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function requireString(body, field) {
  if (typeof body[field] !== "string" || body[field].length === 0) {
    throw new ProtocolError("invalid_envelope", `body.${field} must be a non-empty string.`);
  }
}

function requirePositiveInteger(body, field) {
  if (!Number.isSafeInteger(body[field]) || body[field] < 1) {
    throw new ProtocolError("invalid_envelope", `body.${field} must be a positive integer.`);
  }
}

export function validateEnvelope(envelope) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new ProtocolError("invalid_envelope", "Request frame must be an object.");
  }
  const fields = Object.keys(envelope);
  if (fields.length !== ENVELOPE_FIELDS.size || fields.some((field) => !ENVELOPE_FIELDS.has(field))) {
    throw new ProtocolError("invalid_envelope", "Request frame does not match the lifetime envelope.");
  }
  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    throw new ProtocolError("unsupported_version", "Unsupported lifetime protocol version.");
  }
  if (typeof envelope.command_id !== "string" || envelope.command_id.length === 0 || envelope.command_id.length > 400) {
    throw new ProtocolError("invalid_envelope", "command_id must contain 1–400 characters.");
  }
  if (typeof envelope.actor_ref !== "string" || envelope.actor_ref.length === 0) {
    throw new ProtocolError("invalid_envelope", "actor_ref must be a non-empty string.");
  }
  if (typeof envelope.correlation_id !== "string" || envelope.correlation_id.length === 0) {
    throw new ProtocolError("invalid_envelope", "correlation_id must be a non-empty string.");
  }
  if (!Number.isSafeInteger(envelope.authority_epoch) || envelope.authority_epoch < 1) {
    throw new ProtocolError("invalid_envelope", "authority_epoch must be a positive integer.");
  }
  if (envelope.expected_revision !== null &&
      (!Number.isSafeInteger(envelope.expected_revision) || envelope.expected_revision < 1)) {
    throw new ProtocolError("invalid_envelope", "expected_revision must be null or a positive integer.");
  }
  if (envelope.body === null || typeof envelope.body !== "object" || Array.isArray(envelope.body)) {
    throw new ProtocolError("invalid_envelope", "body must be an object.");
  }
  if (typeof envelope.payload_digest !== "string" || !/^[a-f0-9]{64}$/.test(envelope.payload_digest)) {
    throw new ProtocolError("invalid_envelope", "payload_digest must be a lowercase SHA-256 digest.");
  }
  if (payloadDigest(envelope.body) !== envelope.payload_digest) {
    throw new ProtocolError("payload_digest_mismatch", "payload_digest does not match body.");
  }

  const { body } = envelope;
  if (typeof body.method !== "string" || !METHODS.has(body.method)) {
    throw new ProtocolError("unsupported_method", "Unsupported Pi runtime method.");
  }
  requireString(body, "ghost_id");
  requireString(body, "conversation_id");

  switch (body.method) {
    case "conversation.inspect": {
      if (Object.hasOwn(body, "selected_task_inspection")) {
        const target = body.selected_task_inspection;
        if (Object.keys(body).length !== 4 || target === null || typeof target !== "object" || Array.isArray(target)
          || Object.keys(target).length !== 1 || !Object.hasOwn(target, "turn_id")
          || typeof target.turn_id !== "string" || target.turn_id.length < 1 || Buffer.byteLength(target.turn_id, "utf8") > 400) {
          throw new ProtocolError("invalid_envelope", "selected_task_inspection requires only one exact bounded turn.");
        }
      }
      break;
    }
    case "runtime.reconcile": {
      if (Object.hasOwn(body, "selected_task_recovery")) {
        const target = body.selected_task_recovery;
        if (target === null || typeof target !== "object" || Array.isArray(target)
          || Object.keys(target).length !== 2 || !Object.hasOwn(target, "turn_id") || !Object.hasOwn(target, "operation_id")
          || typeof target.turn_id !== "string" || target.turn_id.length < 1 || Buffer.byteLength(target.turn_id, "utf8") > 400
          || typeof target.operation_id !== "string" || !/^selected-task:[a-f0-9]{64}$/u.test(target.operation_id)) {
          throw new ProtocolError("invalid_envelope", "selected_task_recovery requires one exact bounded turn and original admission operation.");
        }
      }
      break;
    }
    case "conversation.status":
      requireString(body, "request_id");
      if (body.request_id.length > 400) {
        throw new ProtocolError("invalid_envelope", "body.request_id exceeds its bounded identity size.");
      }
      break;
    case "conversation.submit":
      requireString(body, "prompt");
      requireString(body, "goal_id");
      requirePositiveInteger(body, "goal_revision");
      if (!["public", "private", "local_only"].includes(body.privacy)) {
        throw new ProtocolError("invalid_envelope", "privacy must be public, private, or local_only.");
      }
      break;
    case "conversation.assignment": {
      const requiredFields = [
        "method", "ghost_id", "conversation_id", "goal_id", "goal_revision", "work_id", "prompt", "privacy",
      ];
      const bodyFields = Object.keys(body);
      if (bodyFields.length !== requiredFields.length || bodyFields.some((field) => !requiredFields.includes(field))) {
        throw new ProtocolError("invalid_envelope", "conversation.assignment requires its exact frozen body fields.");
      }
      requireString(body, "goal_id");
      requireString(body, "work_id");
      requireString(body, "prompt");
      if (body.goal_id.length > 400 || body.work_id.length > 400) {
        throw new ProtocolError("invalid_envelope", "Goal and Work identities exceed their bounded size.");
      }
      requirePositiveInteger(body, "goal_revision");
      if (!["public", "private", "local_only"].includes(body.privacy)) {
        throw new ProtocolError("invalid_envelope", "privacy must be public, private, or local_only.");
      }
      break;
    }
    case "conversation.steer":
      requireString(body, "prompt");
      requireString(body, "goal_id");
      requirePositiveInteger(body, "goal_revision");
      break;
  }
  return { envelope, method: body.method };
}

export function successResponse(summary, data, objectRefs = []) {
  return {
    status: "success",
    summary,
    object_refs: objectRefs,
    artifacts: [],
    next_actions: [],
    error_code: null,
    retry_class: "same_id",
    data,
  };
}

export function errorResponse(code, summary, retryClass = "never", data = null) {
  return {
    status: "error",
    summary,
    object_refs: [],
    artifacts: [],
    next_actions: [],
    error_code: code,
    retry_class: retryClass,
    data,
  };
}

export function protocolHandshake(mode) {
  return {
    protocol_version: PROTOCOL_VERSION,
    contract_revision: CONTRACT_REVISION,
    mode,
    runtime_identity: {
      durable: "@earendil-works/pi-durable@1.1.0",
      pi_ai: "@earendil-works/pi-ai@1.1.0",
      chord: "@earendil-works/chord@1.1.0",
      upstream_commit: "6fb2e7815167e6b19006fc526d1a5d0f5f998787",
      durable_integrity: "sha512-NtuB3RY24vQ+0/rWYpeHupyFWBfXuKq17to3VMYUYqfD/uuGnz6F6UTPBEm51VSxxA6LZwRcDwLX2LtRehnIgQ==",
      node_engine: ">=22.19.0",
    },
  };
}
