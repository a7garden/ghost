import { Type } from "@earendil-works/pi-ai";

// Native Oxibrain uses signed epoch milliseconds. Keep JSON integer identity
// exact; dates, null, fractions and unsafe rounded numbers are not timestamps.
export function memoryQueryProperties() {
  return {
    as_of: Type.Optional(Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })),
    known_at: Type.Optional(Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })),
    planes: Type.Optional(Type.Array(Type.Union([Type.Literal("memory"), Type.Literal("documents")]), { minItems: 1, maxItems: 2, uniqueItems: true })),
  };
}
export const MEMORY_QUERY_FIELDS = Object.freeze(["as_of", "known_at", "planes"]);
export function memoryQueryArguments(args) {
  const selected = {};
  for (const key of ["as_of", "known_at"]) {
    if (!Object.hasOwn(args, key)) continue;
    if (!Number.isSafeInteger(args[key])) throw new Error("Temporal memory scope requires safe integer epoch milliseconds.");
    selected[key] = args[key];
  }
  if (Object.hasOwn(args, "planes")) {
    if (!Array.isArray(args.planes) || args.planes.length < 1 || args.planes.length > 2
      || new Set(args.planes).size !== args.planes.length || args.planes.some(value => !["memory", "documents"].includes(value))) throw new Error("Memory planes require unique memory/documents selections.");
    selected.planes = [...args.planes];
  }
  return selected;
}
