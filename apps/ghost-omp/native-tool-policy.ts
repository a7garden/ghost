export const NATIVE_OMP_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "glob",
  "ast_grep",
  "ast_edit",
  "eval",
  "todo",
] as const;

export const PUBLISH_ARTIFACT_TOOL_NAMES = ["publish_artifact"] as const;
export const WORKER_TOOL_NAMES = [...NATIVE_OMP_TOOL_NAMES, ...PUBLISH_ARTIFACT_TOOL_NAMES] as const;
export const BROWSER_WORKER_TOOL_NAMES = [...WORKER_TOOL_NAMES, "browser"] as const;
export type NativeOmpToolName = (typeof NATIVE_OMP_TOOL_NAMES)[number];
export type WorkerToolName = (typeof BROWSER_WORKER_TOOL_NAMES)[number];
export const WORKER_TOOL_APPROVALS = Object.fromEntries(
  BROWSER_WORKER_TOOL_NAMES.map((name) => [name, "allow"]),
) as Record<WorkerToolName, "allow">;

export function hasExactWorkerToolScope(value: unknown): value is WorkerToolName[] {
  return Array.isArray(value)
    && (value.length === WORKER_TOOL_NAMES.length || value.length === BROWSER_WORKER_TOOL_NAMES.length)
    && value.every((name, index) => name === BROWSER_WORKER_TOOL_NAMES[index]);
}
