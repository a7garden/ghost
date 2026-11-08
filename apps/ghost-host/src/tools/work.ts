import { Type } from "typebox";
import { Check } from "@ghost/contract";
import { defineExtension, defineTool, type Extension, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import type { Core } from "../core/core.ts";
import { KnownOutcome, NoEffect } from "../core/effects.ts";
import { invalid } from "../core/errors.ts";
import { idFor } from "../core/ids.ts";
import type { SandboxEnvFactory } from "../integrations/ports.ts";
import { describeOutcome, describeWork } from "../core/works.ts";
import { parseShellResult, type ShellResult } from "../core/verify.ts";
import { askOwnerTool, errorResult, requireAllowed, requireWork, scopeOf } from "./shared.ts";

const text = (message: string): ToolExecutionResult => ({ content: [{ type: "text", text: message }] });

/** Tail of each output stream kept in the recorded ShellResult. */
const SHELL_STDOUT_TAIL = 8_000;
const SHELL_STDERR_TAIL = 4_000;
/** Effects trims recorded results to this length; stay inside it so the JSON stays parseable. */
const MAX_SHELL_RESULT = 16_384;
/** Largest file publish_artifact will read into memory. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/**
 * The recorded result of one `bash` call: exit code plus bounded, tail-preserving output.
 * A non-zero exit, timeout or abort is a known outcome recorded in the journal, not an unknown.
 */
function shellRecord(shell: { exitCode: number; stdout: string; stderr: string }): ShellResult {
  let cap = 4_000;
  for (;;) {
    const record: ShellResult = { exitCode: shell.exitCode, stdout: shell.stdout.slice(-cap), stderr: shell.stderr.slice(-cap) };
    if (JSON.stringify(record).length <= MAX_SHELL_RESULT || cap <= 256) return record;
    cap = Math.floor(cap / 2);
  }
}

/** Run one command through the call's environment, keeping the streams apart for the journal. */
async function runShell(env: ExecutionEnv, command: string, timeout: number | undefined, api: ToolExecutionApi, context: Context): Promise<ShellResult> {
  let stdout = "";
  let stderr = "";
  const result = await env.exec(
    command,
    {
      ...(timeout === undefined ? {} : { timeout }),
      onOutput: (chunk, _context, info) => {
        if (info.stream === "stdout") stdout = (stdout + chunk).slice(-SHELL_STDOUT_TAIL);
        else stderr = (stderr + chunk).slice(-SHELL_STDERR_TAIL);
        api.output(chunk);
      },
    },
    context,
  );
  if (!result.ok) {
    if (result.error.code === "shell_unavailable" || result.error.code === "spawn_error") throw new NoEffect(`the command did not run: ${result.error.message}`);
    if (result.error.code === "timeout" || result.error.code === "aborted") {
      const note = result.error.code === "timeout" ? `[timed out after ${timeout} seconds]` : "[aborted]";
      return shellRecord({ exitCode: 124, stdout, stderr: `${stderr}\n${note}`.trim() });
    }
    throw result.error;
  }
  return shellRecord({ exitCode: result.value.exitCode, stdout, stderr });
}

/**
 * A workspace-relative path confined to the workspace: no absolute paths, no `..`,
 * and no symlink anywhere along the way. Refusals are NoEffect: nothing was read.
 */
function confinedPath(base: string, rel: string): string {
  if (isAbsolute(rel)) throw new NoEffect("path must be relative to the workspace");
  if (rel.split(/[\\/]+/).includes("..")) throw new NoEffect("path must not contain `..`");
  let current = base;
  let info = lstatSync(current, { throwIfNoEntry: false });
  for (const segment of rel.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    current = join(current, segment);
    if (!current.startsWith(base + sep)) throw new NoEffect("path escapes the workspace");
    info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) throw new NoEffect(`no file at ${rel}`);
    if (info.isSymbolicLink()) throw new NoEffect(`${rel} traverses a symlink`);
  }
  if (!info?.isFile()) throw new NoEffect(`${rel} is not a regular file`);
  return current;
}

/** Model-facing reason for a filesystem failure; the host path never enters the transcript. */
function fsReason(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code !== "string") return null;
  switch (code) {
    case "ENOENT":
      return "the file disappeared";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EISDIR":
      return "it is a directory";
    case "EMFILE":
    case "ENFILE":
      return "too many open files";
    default:
      return `filesystem error ${code}`;
  }
}

/**
 * Read a workspace file whole but never more than MAX_ARTIFACT_BYTES: the size comes from
 * `fstat` of the open descriptor and the read is capped at that many bytes, so nothing is
 * allocated before the size check and the file cannot grow past the cap mid-read.
 */
function readCapped(path: string, rel: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NoEffect(`${rel} is not a regular file`);
    if (info.size > MAX_ARTIFACT_BYTES) throw new NoEffect(`${rel} is larger than ${MAX_ARTIFACT_BYTES} bytes`);
    const bytes = new Uint8Array(info.size);
    let read = 0;
    while (read < bytes.length) {
      const chunk = readSync(fd, bytes, read, bytes.length - read, read);
      if (chunk === 0) break;
      read += chunk;
    }
    return read === bytes.length ? bytes : bytes.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** Largest file whose bytes are compared to classify a failed write. */
const MAX_STATE_BYTES = 16 * 1024 * 1024;

/**
 * sha256 of a regular workspace file; null when absent; undefined when it cannot be
 * compared safely (outside the workspace, a symlink, a FIFO or device, or too large).
 */
function fileState(root: string, path: string): string | null | undefined {
  const relative = path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;
  if (isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) return undefined;
  const target = join(root, relative);
  const info = lstatSync(target, { throwIfNoEntry: false });
  if (!info) return null;
  if (!info.isFile() || info.size > MAX_STATE_BYTES) return undefined;
  try {
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * A write or edit that throws without changing the file had no effect (a refused edit,
 * a validation error); only a failure that changed or may have changed the file stays unknown.
 */
async function unchangedMeansNoEffect(root: string, path: string, perform: () => Promise<void>) {
  const before = fileState(root, path);
  try {
    await perform();
  } catch (error) {
    if (before !== undefined && fileState(root, path) === before) throw new NoEffect(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function createWorkTools(core: Core, sandbox: SandboxEnvFactory): Extension {
  const write = createWriteTool();
  const edit = createEditTool();

  const baseRead = createReadTool();

  // `read` comes from the harness; its only host rule is the allow-list guard, applied before any file is touched.
  const read = defineTool({
    ...baseRead,
    replay: "safe",
    async execute(args, api, context) {
      try {
        requireAllowed(core, api, "read");
      } catch (error) {
        return errorResult(error);
      }
      return baseRead.execute(args, api, context);
    },
  });

  const writeTool = defineTool({
    ...write,
    replay: "unsafe",
    async execute(args, api, context) {
      try {
        const scope = requireWork(requireAllowed(core, api, "write"));
        let fresh: ToolExecutionResult | null = null;
        const recorded = await core.effects.run(
          { conversationId: scope.conversation.id, callId: api.callId, tool: "write", input: args, summary: `write ${args.path}` },
          async () => {
            await unchangedMeansNoEffect(sandbox.workspacePath(scope.work), args.path, async () => {
              fresh = await write.execute(args, api, context);
            });
            return `Wrote ${Buffer.byteLength(args.content)} bytes to ${args.path}.`;
          },
        );
        return fresh ?? { content: [{ type: "text", text: recorded }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const editTool = defineTool({
    ...edit,
    replay: "unsafe",
    async execute(args, api, context) {
      try {
        const scope = requireWork(requireAllowed(core, api, "edit"));
        let fresh: ToolExecutionResult | null = null;
        const recorded = await core.effects.run(
          { conversationId: scope.conversation.id, callId: api.callId, tool: "edit", input: args, summary: `edit ${args.path}` },
          async () => {
            await unchangedMeansNoEffect(sandbox.workspacePath(scope.work), args.path, async () => {
              fresh = await edit.execute(args, api, context);
            });
            return `Edited ${args.path} (${args.edits.length} block(s)).`;
          },
        );
        return fresh ?? { content: [{ type: "text", text: recorded }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const bash = defineTool({
    name: "bash",
    description: "Run one bash command in the work sandbox. Returns the exit code and the tail of stdout and stderr.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 2048 }),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds" })),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      try {
        const scope = requireWork(requireAllowed(core, api, "bash"));
        if (!api.env) throw new Error("no sandbox environment for this conversation");
        const env = api.env;
        const recorded = await core.effects
          .run(
            {
              conversationId: scope.conversation.id,
              callId: api.callId,
              tool: "bash",
              input: { command: args.command, timeout: args.timeout ?? null },
              summary: args.command,
            },
            async () => {
              const shell = await runShell(env, args.command, args.timeout, api, context);
              const json = JSON.stringify(shell);
              if (shell.exitCode !== 0) throw new KnownOutcome(json);
              return json;
            },
          )
          .catch((error: unknown) => {
            if (error instanceof KnownOutcome) return error.message;
            throw error;
          });
        const shell = parseShellResult(recorded) ?? { exitCode: 125, stdout: "", stderr: "the recorded result could not be read back" };
        const output = [
          `exit ${shell.exitCode}`,
          shell.stdout.trim() && `[stdout]\n${shell.stdout}`,
          shell.stderr.trim() && `[stderr]\n${shell.stderr}`,
        ]
          .filter(Boolean)
          .join("\n");
        if (shell.exitCode !== 0) throw new Error(output);
        return text(output);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const publishArtifact = defineTool({
    name: "publish_artifact",
    description: "Publish a workspace file as an artifact of this Work. `complete` can only name published artifacts.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 4096, description: "Workspace-relative path of the file" }),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Artifact name; defaults to the file name" })),
      media_type: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Defaults to application/octet-stream" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(requireAllowed(core, api, "publish_artifact"));
        const name = args.name ?? basename(args.path);
        const digest = await core.effects.run(
          {
            conversationId: scope.conversation.id,
            callId: api.callId,
            tool: "publish_artifact",
            input: { path: args.path, name, media_type: args.media_type ?? null },
            summary: `publish ${args.path} as ${name}`,
          },
          async (): Promise<string> => {
            const base = realpathSync(sandbox.workspacePath(scope.work));
            const path = confinedPath(base, args.path);
            let bytes: Uint8Array;
            try {
              bytes = readCapped(path, args.path);
            } catch (error) {
              const reason = fsReason(error);
              if (reason === null) throw error;
              throw new NoEffect(`${args.path} could not be read: ${reason}; nothing was published`);
            }
            const ref = await core.artifacts.put(bytes, name, args.media_type ?? "application/octet-stream");
            core.ledger.tx(() => core.ledger.addArtifact(scope.work.id, ref));
            return ref.digest;
          },
        );
        return text(`Published ${name} (${digest.slice(0, 12)}).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const delegate = defineTool({
    name: "delegate",
    description:
      "Hand a self-contained part of this Work to another Ghost. Optional checks gate review; the named reviewer or delegating Ghost still judges a passing result.",
    parameters: Type.Object({
      ghost_id: Type.String({ minLength: 1, description: "Assignee Ghost" }),
      title: Type.String({ minLength: 1, maxLength: 256 }),
      brief: Type.String({ minLength: 1, maxLength: 32768 }),
      criteria: Type.Optional(Type.String({ maxLength: 8192, description: "When the delegated Work is done" })),
      checks: Type.Optional(Type.Array(Check, { maxItems: 16, description: "Deterministic checks the child must pass before review" })),
      reviewer_ghost_id: Type.Optional(
        Type.String({ minLength: 1, description: "Ghost that reviews the result; defaults to the Ghost that delegated" }),
      ),
      deadline_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "Deadline in minutes from now; capped by this Work's own deadline" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(requireAllowed(core, api, "delegate"));
        const child = core.works.delegate(scope.work.id, {
          ghostId: args.ghost_id,
          title: args.title,
          brief: args.brief,
          acceptance: {
            criteria: args.criteria ?? "",
            checks: args.checks ?? [],
            reviewer: args.reviewer_ghost_id ? { kind: "ghost", ghostId: args.reviewer_ghost_id } : null,
          },
          deadlineAt: args.deadline_minutes === undefined ? null : Date.now() + args.deadline_minutes * 60_000,
          id: idFor(scope.conversation.id, api.callId),
        });
        return text(`Delegated "${child.title}" (${child.id}) to ${core.ledger.ghost(child.ghostId).name}. Its result arrives here.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const askParent = defineTool({
    name: "ask_parent",
    description: "Ask the Ghost that delegated this child Work. Wait for its answer; root Works use ask_owner.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8192 }) }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(scopeOf(core, api));
        const question = core.works.askParent(scope.work.id, args.question, idFor(scope.conversation.id, api.callId));
        return text(`Your delegating Ghost was asked (${question.id}). Its answer arrives as a message.`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const answerChild = defineTool({
    name: "answer_child",
    description: "Answer a pending question from one of this Work's own children, promptly. Escalate owner-only decisions with ask_owner first.",
    parameters: Type.Object({
      question_id: Type.String({ minLength: 1 }),
      answer: Type.String({ minLength: 1, maxLength: 8192 }),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(scopeOf(core, api));
        const question = core.works.answerChild(scope.work.id, args.question_id, args.answer);
        return text(`Answer recorded for child Work ${question.workId} (question ${question.id}).`);
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const complete = defineTool({
    name: "complete",
    description: "Claim this Work done with a truthful summary and the artifacts you published. Verification decides acceptance.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 16384, description: "What was done and what the result is" }),
      artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64, description: "Names of artifacts published with publish_artifact" })),
    }),
    replay: "unsafe",
    async execute(args, api) {
      try {
        const scope = requireWork(scopeOf(core, api));
        const published = core.ledger.artifactsForWork(scope.work.id);
        const artifacts = (args.artifacts ?? []).map((name) => {
          const ref = published.find((candidate) => candidate.name === name);
          if (!ref) throw invalid(`artifact ${name} was not published by this Work; call publish_artifact first`);
          return ref;
        });
        const work = core.works.complete(scope.work.id, { summary: args.summary, artifacts });
        return {
          content: [{ type: "text", text: `Work "${work.title}" claimed complete; it is ${work.state} until verification settles it.` }],
          control: { terminate: true },
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  const workStatus = defineTool({
    name: "work_status",
    description: "This Work's own state, its children's outcomes and its published artifacts.",
    parameters: Type.Object({}),
    replay: "safe",
    async execute(_args, api) {
      try {
        const scope = requireWork(scopeOf(core, api));
        const work = core.ledger.work(scope.work.id);
        const children = core.ledger.children(work.id);
        const artifacts = core.ledger.artifactsForWork(work.id);
        const parts = [
          describeWork(work),
          `State: ${work.state}${work.verdict ? ` — ${work.verdict.outcome} verdict` : ""}${work.reason ? ` — ${work.reason}` : ""}`,
          children.length
            ? `Children:\n${children.map((child) => `  ${describeOutcome(child).replaceAll("\n", "\n  ")}`).join("\n")}`
            : "",
          artifacts.length ? `Artifacts:\n${artifacts.map((artifact) => `  - ${artifact.name} ${artifact.digest.slice(0, 12)} (${artifact.size} bytes)`).join("\n")}` : "",
          core.ledger.workQuestions(work.id).length
            ? `Questions to parent:\n${core.ledger.workQuestions(work.id).map((question) => `- ${question.id} [${question.state}]: ${question.question}${question.answer ? `\n  Answer: ${question.answer}` : ""}`).join("\n")}`
            : "",
          core.ledger.workQuestions(work.id, true).some((question) => question.state === "pending")
            ? `Children awaiting answers:\n${core.ledger.workQuestions(work.id, true).filter((question) => question.state === "pending").map((question) => `- ${question.id} (child ${question.workId}): ${question.question}`).join("\n")}`
            : "",
        ];
        return text(parts.filter(Boolean).join("\n\n"));
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  return defineExtension({
    name: "ghost.work",
    tools: [read, writeTool, editTool, bash, publishArtifact, delegate, complete, workStatus, askParent, answerChild, askOwnerTool(core)],
  });
}
