import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createBashTool, createEditTool, createLsTool, createReadTool, createWriteTool, defineTool, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CodingDialogOption } from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import { buildSeatbeltPolicy, explainSeatbeltRefusal, SEATBELT_EXEC, seatbeltProfile, type SeatbeltPolicy } from "../sandbox/seatbelt.ts";
import { killTree } from "../sandbox/workspace-env.ts";
import type { Dialogs } from "./dialogs.ts";
import { type CodingFiles, readRegular, safePath, writePatch, writeRegular } from "./workspace.ts";

export const READ_TOOLS = ["read", "grep", "find", "ls"];
export const WORKER_TOOLS = [...READ_TOOLS, "edit", "write", "bash"];
const FILE_TOOLS = new Set([...READ_TOOLS, "edit", "write"]);
const MAX_TIMEOUT = 15 * 60;

const choices = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 400 }), message: Type.Optional(Type.String({ maxLength: 4000 })),
  options: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 80 }), label: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(Type.String({ maxLength: 600 })), image: Type.Optional(Type.String({ maxLength: 1024 })),
    html: Type.Optional(Type.String({ maxLength: 1024 })),
  }), { minItems: 1, maxItems: 12 }),
  allowText: Type.Optional(Type.Boolean()),
});

export function toolExtension(files: CodingFiles, dialogs: Dialogs, ownerChoices: boolean, subagent?: ToolDefinition, skillPath?: (path: string) => string | null): ExtensionFactory {
  return pi => {
    const beforeWrites = new Map<string, { path: string; text: string | null }>();
    pi.on("tool_call", event => {
      if (!FILE_TOOLS.has(event.toolName)) return;
      try {
        const raw = "path" in event.input && typeof event.input.path === "string" ? event.input.path : ".";
        const write = event.toolName === "edit" || event.toolName === "write";
        // Don't pass the model's spelling to Pi: it also expands ~/ @ and file:// paths.
        const path = (event.toolName === "read" ? skillPath?.(raw) : null) ?? safePath(files.cwd, raw, event.toolName === "write");
        const rel = relative(files.cwd, path);
        if (write && (rel === ".git" || rel.startsWith(".git/"))) throw invalid("file tools cannot rewrite git metadata");
        if (event.toolName === "write") {
          let previous: string | null = null;
          const info = lstatSync(path, { throwIfNoEntry: false });
          if (info) previous = readRegular(path, 8 * 1024 * 1024).toString("utf8");
          beforeWrites.set(event.toolCallId, { path: rel, text: previous });
        }
        Object.assign(event.input, { path });
      } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    });
    pi.on("tool_result", event => {
      const before = beforeWrites.get(event.toolCallId);
      if (!before || event.toolName !== "write") return;
      beforeWrites.delete(event.toolCallId);
      if (event.isError || typeof event.input.content !== "string") return;
      const patch = writePatch(before.path, before.text, event.input.content);
      if (patch !== undefined) return { details: { patch } };
    });
    if (!ownerChoices) return;
    pi.registerTool(defineTool({
      name: "ask_owner_choices", label: "Ask the owner", description: "Pause for the owner's choice. Image and HTML previews must be relative files in the current directory. HTML is static, without scripts.",
      parameters: choices,
      async execute(_id, input, signal) {
        const used = new Set<string>();
        const options: CodingDialogOption[] = input.options.map(option => {
          if (used.has(option.id)) throw invalid("choice ids must be unique");
          used.add(option.id);
          const { image, html, ...fields } = option;
          if (html) files.preview(html, "html");
          return { ...fields, html, ...(image ? { image: { path: image, mimeType: files.preview(image, "image").mimeType } } : {}) };
        });
        const answer = await dialogs.ask({ kind: "choices", title: input.title, message: input.message, options, allowText: input.allowText }, { signal });
        return { content: [{ type: "text", text: JSON.stringify(answer) }], details: undefined };
      },
    }));
    if (subagent) pi.registerTool(subagent);
  };
}

export function codingFileTools(files: CodingFiles, root: string, skillPath?: (path: string) => string | null): ToolDefinition[] {
  const { cwd } = files;
  const readFile = async (path: string) => readRegular(safePath(cwd, path), 32 * 1024 * 1024);
  const writeFile = async (path: string, text: string) => writeRegular(safePath(cwd, path, true), text);
  const access = async (path: string) => { safePath(cwd, path); };
  return [
    createReadTool(cwd, { autoResizeImages: false, operations: {
      access: async path => { if (!skillPath?.(path)) safePath(cwd, path); },
      readFile: async path => readRegular(skillPath?.(path) ?? safePath(cwd, path), 32 * 1024 * 1024),
      detectImageMimeType: async path => {
        const mime = Bun.file(skillPath?.(path) ?? safePath(cwd, path)).type.split(";")[0];
        return mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) ? mime : null;
      },
    } }),
    { ...createEditTool(cwd, { operations: { access, readFile, writeFile } }), executionMode: "sequential" },
    { ...createWriteTool(cwd, { operations: { writeFile, mkdir: async path => {
      const target = safePath(cwd, path, true);
      if (lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) return;
      if (process.platform !== "darwin") { mkdirSync(target, { recursive: true }); return; }
      const policy = buildSeatbeltPolicy(homedir(), root, { writeRoots: [cwd], readRoots: [], proxyPort: null });
      policy.tempRoots = [];
      const argv = ["/bin/mkdir", "-p", "--", target];
      let error = "";
      const exit = await shell(seatbeltCommand(policy, argv), cwd, { timeout: 10 }, chunk => { error = (error + chunk.toString()).slice(-1000); });
      if (exit !== 0) throw invalid(error || "could not create the coding directory");
    } } }), executionMode: "sequential" },
    createLsTool(cwd, { operations: {
      exists: path => { safePath(cwd, path); return true; },
      stat: path => lstatSync(safePath(cwd, path)),
      readdir: path => readdirSync(safePath(cwd, path)),
    } }),
    ...searchTools(cwd, root),
  ];
}

interface ShellOptions { signal?: AbortSignal; timeout?: number }

function seatbeltCommand(policy: SeatbeltPolicy, argv: string[], allowedNetwork?: ReadonlySet<number>): string[] {
  const { profile, definitions } = seatbeltProfile(policy);
  // Local app HTML carries the owner credential. General-purpose coding bash
  // must not use the Host listener to turn model output into owner operations.
  // Match the bound port on every address (including loopback aliases).
  const network = allowedNetwork
    ? "\n(allow network*)\n" + Array.from(allowedNetwork, port => `(deny network-outbound (remote ip "*:${port}"))`).join("\n")
    : "";
  return [SEATBELT_EXEC, ...definitions.flatMap(pair => ["-D", pair]), "-p", profile + network, ...argv];
}

function searchTools(cwd: string, root: string): ToolDefinition[] {
  // Pi's native helpers may execute binaries from ~/.pi or download them. These never consult it.
  return [
    defineTool({
      name: "find", label: "find", description: "Find paths matching a glob inside the coding directory.",
      parameters: Type.Object({ path: Type.Optional(Type.String()), pattern: Type.String({ minLength: 1, maxLength: 500 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
      async execute(_id, input, signal) {
        const start = safePath(cwd, input.path ?? ".");
        const pattern = new Bun.Glob(input.pattern.includes("/") ? input.pattern : `**/${input.pattern}`);
        const all = new Bun.Glob("**/*");
        const matches: string[] = [];
        let scanned = 0;
        const limit = input.limit ?? 1000;
        for await (const name of all.scan({ cwd: start, dot: true, onlyFiles: false, followSymlinks: false })) {
          signal?.throwIfAborted();
          if (++scanned > 40_000 || matches.length >= limit) break;
          if (name.split("/").some(part => part === ".git" || part === "node_modules") || !pattern.match(name)) continue;
          try { safePath(start, name); matches.push(name); } catch { /* links/replaced files are not results */ }
        }
        const result = matches.join("\n").slice(0, 18_000);
        return { content: [{ type: "text", text: result + (scanned > 40_000 || matches.length >= limit || result.length >= 18_000 ? "\n[find limit reached]" : "") || "No matching files." }], details: undefined };
      },
    }),
    defineTool({
      name: "grep", label: "grep", description: "Search coding files with an extended regular expression or literal text. Returns paths and line numbers.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()), pattern: Type.String({ maxLength: 2000 }), glob: Type.Optional(Type.String({ maxLength: 500 })),
        ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      }),
      async execute(_id, input, signal) {
        const path = safePath(cwd, input.path ?? ".");
        const argv = ["/usr/bin/grep", "-rInH", input.literal ? "-F" : "-E", "--exclude-dir=.git", "--exclude-dir=node_modules",
          ...(input.ignoreCase ? ["-i"] : []), ...(input.glob ? [`--include=${input.glob}`] : []),
          ...(input.context ? ["-C", String(input.context)] : []), "--", input.pattern, relative(cwd, path) || "."];
        const policy = buildSeatbeltPolicy(homedir(), root, { writeRoots: [], readRoots: [cwd], proxyPort: null });
        policy.tempRoots = [];
        let text = "";
        const timeout = 12;
        const exit = await shell(process.platform === "darwin" ? seatbeltCommand(policy, argv) : argv, cwd, { signal, timeout }, data => {
          if (text.length < 18_000) text += data.toString().slice(0, 18_000 - text.length);
        });
        if (exit !== 0 && exit !== 1) throw invalid(text || "grep failed");
        const lines = text.trimEnd().split("\n");
        const limit = input.limit ?? 100;
        const bounded = lines.slice(0, limit).join("\n");
        return { content: [{ type: "text", text: (bounded || "No matches.") + (lines.length > limit || text.length >= 18_000 ? "\n[grep output limited]" : "") }], details: undefined };
      },
    }),
  ];
}

async function shell(argv: string[], cwd: string, options: ShellOptions, onData: (data: Buffer) => void): Promise<number | null> {
  options.signal?.throwIfAborted();
  const env = { HOME: homedir(), TMPDIR: tmpdir(), PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8", GIT_TERMINAL_PROMPT: "0" };
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const { promise, resolve, reject } = Promise.withResolvers<number | null>();
  const stop = () => { if (child.pid !== undefined) killTree(child.pid); };
  const timeout = Math.max(0.1, Math.min(options.timeout || MAX_TIMEOUT, MAX_TIMEOUT));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout * 1000);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("error", reject);
  child.once("close", (code, signal) => {
    // Also terminate any background jobs that detached only from the shell, not its group.
    stop();
    if (timedOut) reject(new Error(`Command timed out after ${timeout} seconds`));
    else if (options.signal?.aborted) reject(options.signal.reason);
    else resolve(signal ? 128 : code);
  });
  options.signal?.addEventListener("abort", stop, { once: true });
  try { return await promise; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", stop); }
}

export function codingBash(root: string, cwd: string, dialogs: Dialogs, gitCommon: string | null, hostPorts: ReadonlySet<number>): ToolDefinition {
  return { ...createBashTool(cwd, { exposeSessionEnvironment: false, operations: {
    async exec(command, _cwd, options) {
      if (process.platform !== "darwin") throw new Error("coding bash requires macOS Seatbelt");
      if (realpathSync(cwd) !== cwd) throw invalid("coding directory was replaced");
      const cache = [".bun", ".cache", ".npm", "Library/Caches"].map(path => join(homedir(), path));
      const policy = buildSeatbeltPolicy(homedir(), root, { writeRoots: [cwd, realpathSync(tmpdir()), ...cache], readRoots: gitCommon ? [gitCommon] : [], proxyPort: null });
      policy.tempRoots = []; // Only the explicit system temp and package cache roots are writable.
      const argv = ["/bin/bash", "--noprofile", "--norc", "-c", command];
      const confined = seatbeltCommand(policy, argv, hostPorts);
      let tail = "";
      const exitCode = await shell(confined, cwd, options, data => {
        options.onData(data);
        tail = (tail + data.toString()).slice(-8000);
      });
      if (exitCode === 0 || !/operation not permitted|permission denied|sandbox(?:-exec)?[: ]/i.test(tail)) return { exitCode };
      const refusal = explainSeatbeltRefusal(tail, { cwd, policy });
      if (!refusal || /^(?:sandbox-exec:|sandbox_apply:)/m.test(tail)) return { exitCode };
      if (command.length > 3600) {
        options.onData(Buffer.from("\n[This command is too long to display in an approval dialog. Split it into smaller commands.]\n"));
        return { exitCode };
      }
      const answer = await dialogs.ask({ kind: "approval", title: "작업 폴더 밖 명령을 허용할까요?",
        message: `앞선 실행은 일부 작업을 이미 수행했을 수 있습니다. 허용하면 이 호출만 격리 없이 다시 실행합니다.\n\n${command}`,
        tool: { name: "bash", summary: command.slice(0, 2000) },
      }, { signal: options.signal });
      if (answer.value !== "yes") return { exitCode };
      options.signal?.throwIfAborted();
      options.onData(Buffer.from("\n[The owner approved re-running this call outside Seatbelt.]\n"));
      return { exitCode: await shell(argv, cwd, options, options.onData) };
    },
  } }), executionMode: "sequential" };
}
