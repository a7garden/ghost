import { describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  chmodSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { HOST_TOOLS } from "@ghost/contract";
import {
  MacHost,
  isReadOnlyHostCommand,
  redactHostText,
  runHostCommand,
  sensitiveText,
  type HostRun,
  type HostRunner,
  type HostOutput,
} from "../src/integrations/host.ts";
import type {
  HostCommand,
  HostPort,
  HostStatus,
  HostServices,
  HostNodes,
} from "../src/integrations/ports.ts";
import { HostWatch } from "../src/core/hostwatch.ts";
import { createHostTools } from "../src/tools/host.ts";
import { loadConfig } from "../src/config.ts";
import { harness, tempDir } from "./support.ts";
import { openApp, type App } from "../src/app.ts";
import { CommandError } from "../src/core/errors.ts";

const GB = 1_073_741_824;
const HOUR = 3_600_000;
function fixture(runner?: HostRunner) {
  const home = realpathSync(tempDir());
  const root = join(home, "projects");
  mkdirSync(root);
  mkdirSync(join(home, "Library/Caches"), { recursive: true });
  mkdirSync(join(home, ".cache"));
  const stateRoot = join(home, "Library/Application Support/Ghost");
  mkdirSync(stateRoot, { recursive: true });
  return { home, root, stateRoot, host: new MacHost({ roots: [root], home, runner, stateRoot }) };
}
const ok = (output = "") => ({
  exitCode: 0,
  stdout: output,
  stderr: "",
  output,
  timedOut: false,
  truncated: false,
});
function command(root: string): HostCommand {
  return {
    title: "Check",
    reason: "Inspect explicitly",
    program: "/bin/echo",
    args: ["hello"],
    cwd: root,
    risk: "No writes",
  };
}

class Probes implements HostPort {
  free = 100 * GB;
  total = 200 * GB;
  lastExit = 0;
  online = true;
  executions = 0;
  statusCalls = 0;
  async status(): Promise<HostStatus> {
    this.statusCalls++;
    return {
      collectedAt: 0,
      disks: [
        {
          path: "/",
          volumeId: "main",
          totalBytes: this.total,
          freeBytes: this.free,
          pressure:
            this.free < 5 * GB
              ? "critical"
              : this.free < 50 * GB
                ? "pressure"
                : "healthy",
        },
      ],
      ramBytes: 32 * GB,
      memoryFreePct: 40,
      cores: 8,
      loadAverage: [1, 1, 1],
      topProcesses: [],
      listeningPortCount: 3,
      warnings: [],
    };
  }
  async messageCodes() {
    return { codes: [] };
  }
  async services(): Promise<HostServices> {
    const service = {
      label: "dev.test",
      state: "loaded" as const,
      lastExit: this.lastExit,
    };
    return {
      services: [service],
      failed: this.lastExit ? [service] : [],
      partial: false,
    };
  }
  async nodes(): Promise<HostNodes> {
    return {
      nodes: [
        { name: "test-node", online: this.online, os: "macOS", lastSeen: null },
      ],
      healthWarnings: [],
      error: null,
    };
  }
  async diskScan() {
    return {};
  }
  async diskUsage() {
    return {};
  }
  async list() {
    return {};
  }
  async read() {
    return {};
  }
  validateCommand(input: HostCommand) {
    return input;
  }
  async inspect() {
    return null;
  }
  async executeCommand() {
    this.executions++;
    return ok("executed");
  }
}

describe("guarded Mac host", () => {
  test("ordinary read argv forms execute directly without proposals", async () => {
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok(input.args.includes("config") ? "" : "observed"); });
    const h = harness();
    try {
      for (const dir of ["docs", "qa", "data", "src"]) mkdirSync(join(f.root, dir));
      for (const file of ["docs/X.md", "qa/X.md", "data/free_talk_intents.json", "src/server.ts"])
        writeFileSync(join(f.root, file), "propose 배송 출고\n");
      const source = join(f.root, "src/server.ts");
      const cases: [string, string[]][] = [
        ["/usr/bin/tail", ["-n", "+61", "docs/X.md"]],
        ["/usr/bin/tail", ["-n", "+301", source]],
        ["/usr/bin/sed", ["-n", "100,180p", "qa/X.md"]],
        ["/usr/bin/sed", ["-n", "1,170p", source]],
        ["/usr/bin/sed", ["-n", "-e", "1p", "-e", "$p", "-e", "1,$p", source]],
        ["/usr/bin/grep", ["-n", "propose", source]],
        ["/usr/bin/grep", ["-rn", "-e", "배송", "-e", "출고", f.root]],
        ["/usr/bin/grep", ["-n", "-C", "2", "-e", "배송|출고;$", source]],
        ["/usr/bin/grep", ["-rIl", "-e", "a", "-e", "b", f.root, "--include=*.md", "--include=*.ts"]],
        ["/usr/bin/grep", ["-c", "x", source]],
        ["/usr/bin/grep", ["-R", "-A2", "-B", "1", "-m3", "--exclude=*.log", "--exclude-dir=vendor", "--color=never", "x", f.root]],
        ["/usr/bin/find", [f.root, "-type", "f", "(", "-iname", "*dialog*", "-o", "-iname", "*script*", ")"]],
        ["/usr/bin/find", [f.root, "-newer", source, "-empty", "-ls"]],
        ...["-c", "-l", "-w", "-m"].map((flag): [string, string[]] => ["/usr/bin/wc", [flag, source]]),
        ["/usr/bin/which", ["grep"]],
        ["/bin/cat", ["data/free_talk_intents.json"]],
        ["/bin/ls", ["-d", f.root]],
        ["/usr/bin/git", ["stash", "list"]],
        ["/usr/bin/git", ["-C", f.root, "stash", "list"]],
        ...([
          ["tail", ["-n", "+1", source]], ["sed", ["-n", "1p", source]],
          ["grep", ["-n", "x", source]], ["find", [f.root, "-type", "f"]],
          ["wc", ["-l", source]], ["which", ["grep"]], ["cat", [source]],
          ["ls", ["-d", f.root]], ["git", ["stash", "list"]],
        ] as [string, string[]][]),
      ];
      const ghost = h.core.createGhost({ name: "Reader", persona: "", tools: ["host_command_propose"] });
      h.ledger.setPiConversationId(ghost.directConversationId, "read-argv");
      const tool = createHostTools(h.core, f.host).tools!.find((tool) => tool.name === "host_command_propose")!;
      const invoke = tool.execute as unknown as (input: HostCommand, api: ToolExecutionApi) => Promise<unknown>;
      for (const [index, [program, args]] of cases.entries()) {
        const before = calls.length;
        const result = await invoke({ ...command(f.root), program, args }, {
          conversationId: "read-argv", callId: `read-${index}`,
        } as unknown as ToolExecutionApi);
        expect(JSON.stringify(result)).toContain("observed");
        expect(calls.length).toBeGreaterThan(before);
        expect(h.ledger.pendingDecisions()).toHaveLength(0);
        expect(h.ledger.effectByCall(ghost.directConversationId, `read-${index}`)).toBeNull();
      }
      expect(calls.every((call) => call.inspection && call.program.startsWith("/"))).toBe(true);
      expect(await f.host.read(join(f.root, "data/free_talk_intents.json"))).toMatchObject({ text: "propose 배송 출고\n" });
      mkdirSync(join(f.home, "data"));
      writeFileSync(join(f.home, "data/x"), "private");
      await expect(f.host.read(join(f.home, "data/x"))).rejects.toThrow("private");
      expect(await f.host.inspect({ ...command(f.root), program: "cat", args: [join(f.home, "data/x")] })).toBeNull();
      for (const [program, args] of [
        ["/usr/bin/sed", ["-n", "1w output", source]],
        ["/usr/bin/sed", ["-n", "-e", "1p", "-e", "1r hidden", source]],
        ["/usr/bin/sed", ["-i", "", "1p", source]],
        ["/usr/bin/sed", ["-n", "-f", source, source]],
        ["/usr/bin/grep", ["-f", source, source]],
        ["/usr/bin/grep", ["--file=hidden", source]],
        ["/usr/bin/grep", ["-d", "recurse", "x", f.root]],
        ["/usr/bin/grep", ["--recursive", "x", f.root]],
        ["/usr/bin/grep", ["--dereference-recursive", "x", f.root]],
        ["/usr/bin/grep", ["-D", "read", "x", source]],
        ["/usr/bin/find", [f.root, "-print0"]],
        ["/usr/bin/find", [f.root, "-delete"]],
        ["/usr/bin/find", [f.root, "-exec", "/bin/rm", "{}"]],
      ] as [string, string[]][]) {
        expect(await f.host.inspect({ ...command(f.root), program, args })).toBeNull();
      }
    } finally {
      h.ledger.close();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("host_read tool forwards offset and limit for continuation", async () => {
    const h = harness();
    const f = fixture();
    try {
      const path = join(f.root, "source.txt");
      writeFileSync(path, "one\ntwo\nthree\n");
      const ghost = h.core.createGhost({ name: "Reader", persona: "", tools: ["host_read"] });
      h.ledger.setPiConversationId(ghost.directConversationId, "paged-read");
      const tool = createHostTools(h.core, f.host).tools!.find((tool) => tool.name === "host_read")!;
      const invoke = tool.execute as unknown as (args: { path: string; offset?: number; limit?: number }, api: ToolExecutionApi) => Promise<{ content: { text: string }[] }>;
      const result = await invoke({ path, offset: 2, limit: 1 }, { conversationId: "paged-read", callId: "page" } as unknown as ToolExecutionApi);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ text: "two\n", startLine: 2, endLine: 2, totalLines: 3, nextOffset: 3 });
    } finally {
      h.ledger.close();
      rmSync(f.home, { recursive: true, force: true });
    }
  });


  test("host_read pages bounded full lines and home paths retain all guards", async () => {
    const f = fixture();
    const outside = realpathSync(tempDir());
    try {
      const logs = join(f.home, "Library/Logs");
      mkdirSync(logs);
      const path = join(logs, "large.log");
      const lines = Array.from({ length: 1000 }, (_, index) => `line ${index + 1}: ${"가".repeat(10)}\n`);
      writeFileSync(path, lines.join(""));
      const first = await f.host.read(path);
      expect(first.startLine).toBe(1);
      expect(first.totalLines).toBe(1000);
      expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(12_000);
      expect(first.nextOffset).toBe(first.endLine + 1);
      const second = await f.host.read(path, first.nextOffset!, 2);
      expect(second.text).toBe(lines.slice(first.endLine, first.endLine + 2).join(""));
      expect(second.startLine).toBe(first.nextOffset!);
      expect(second.endLine).toBe(first.endLine + 2);
      const last = await f.host.read(path, 1000);
      expect(last.text).toBe(lines[999]!);
      expect(last.nextOffset).toBeNull();
      await expect(f.host.read(path, 1001)).rejects.toThrow("past EOF");
      await expect(f.host.read(path, 0)).rejects.toThrow("offset");
      await expect(f.host.read(path, 1, 0)).rejects.toThrow("limit");
      expect((await f.host.list(logs)).entries).toContainEqual({ name: "large.log", kind: "file" });
      writeFileSync(join(logs, "empty.txt"), "");
      expect(await f.host.read(join(logs, "empty.txt"))).toMatchObject({ text: "", totalLines: 0, nextOffset: null });
      writeFileSync(join(logs, "too-large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
      await expect(f.host.read(join(logs, "too-large.txt"))).rejects.toThrow("8 MiB");
      writeFileSync(join(logs, "nul.txt"), "binary\0bytes");
      await expect(f.host.read(join(logs, "nul.txt"))).rejects.toThrow("binary");
      for (const privatePath of [join(f.home, ".ssh"), join(f.home, "Documents"), f.stateRoot]) {
        mkdirSync(privatePath, { recursive: true });
        writeFileSync(join(privatePath, "x.txt"), "private");
        await expect(f.host.read(join(privatePath, "x.txt"))).rejects.toThrow();
        await expect(f.host.list(privatePath)).rejects.toThrow();
      }
      writeFileSync(join(outside, "x.txt"), "outside");
      symlinkSync(outside, join(logs, "escape"));
      await expect(f.host.read(join(logs, "escape/x.txt"))).rejects.toThrow("outside owner home");
      await expect(f.host.list(join(logs, "escape"))).rejects.toThrow("outside owner home");
      await expect(f.host.list(outside)).rejects.toThrow("inside owner home");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("grep preserves a literal double-dash pattern when adding guards", async () => {
    const f = fixture();
    try {
      const path = join(f.root, "dash.txt");
      writeFileSync(path, "-- x\nother\n");
      for (const args of [["-e", "--", path], ["-e", "--", "--", path]]) {
        const result = await f.host.inspect({ ...command(f.root), program: "grep", args });
        expect(result?.exitCode).toBe(0);
        expect(result?.output).toBe("-- x\n");
      }
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("recursive grep cannot read secrets, private paths or descendant symlinks", async () => {
    const f = fixture();
    try {
      for (const dir of ["src", "Secrets", "notes"]) mkdirSync(join(f.root, dir));
      writeFileSync(join(f.root, "src/visible.txt"), "needle visible\n");
      writeFileSync(join(f.root, "Secrets/hidden.txt"), "needle secret\n");
      writeFileSync(join(f.root, "notes/hidden.txt"), "needle private\n");
      writeFileSync(join(f.root, ".env"), "needle env\n");
      mkdirSync(join(f.home, "Documents"));
      writeFileSync(join(f.home, "Documents/hidden.txt"), "needle personal\n");
      writeFileSync(join(f.stateRoot, "hidden.txt"), "needle state\n");
      symlinkSync(join(f.home, "Documents/hidden.txt"), join(f.root, "linked.txt"));
      symlinkSync(join(f.home, "Documents"), join(f.root, "linked-dir"));
      for (const flag of ["-rIn", "-RIn"]) {
        expect(await f.host.inspect({ ...command(f.root), program: "grep", args: [flag, "needle", f.home] })).toBeNull();
        expect(await f.host.inspect({ ...command(f.root), program: "grep", args: [flag, "needle", f.root, f.home] })).toBeNull();
        const result = await f.host.inspect({ ...command(f.root), program: "grep", args: [flag, "needle", f.root, "--include=*"] });
        expect(result?.exitCode).toBe(0);
        expect(result?.output).toContain("needle visible");
        for (const hidden of ["needle secret", "needle private", "needle env", "needle personal", "needle state"])
          expect(result?.output).not.toContain(hidden);
      }
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("Ghost state and SQLite sidecars are never inspected, including aliases and recursive probes", async () => {
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok("must not read"); });
    try {
      for (const file of ["browser/key", "browser/home/.agent-browser/session", "ledger.db-wal", "pi.db-shm", "ledger.db-journal"]) {
        const path = join(f.stateRoot, file);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "a".repeat(64));
        expect(await f.host.inspect({ ...command(f.root), program: "/bin/cat", args: [path] })).toBeNull();
      }
      symlinkSync(f.stateRoot, join(f.root, "state-alias"));
      expect(await f.host.inspect({
        ...command(f.root), program: "/bin/cat", args: [join(f.root, "state-alias/browser/key")],
      })).toBeNull();
      const broad = new MacHost({ home: f.home, roots: [f.home], stateRoot: f.stateRoot });
      await expect(broad.read(join(f.stateRoot, "browser/key"))).rejects.toThrow("state root");
      await expect(broad.read(join(f.root, "state-alias/browser/key"))).rejects.toThrow("state root");
      for (const name of ["ledger.db-wal", "pi.db-shm", "ledger.db-journal", "temporary-journal"]) {
        const path = join(f.root, name);
        writeFileSync(path, "sidecar");
        expect(await f.host.inspect({ ...command(f.root), program: "/bin/cat", args: [path] })).toBeNull();
        await expect(f.host.read(path)).rejects.toThrow("secret");
      }
      const storage = join(f.home, "storage");
      mkdirSync(storage);
      writeFileSync(join(storage, "key"), "key");
      symlinkSync(storage, join(f.home, "state-link"));
      const linked = new MacHost({ home: f.home, roots: [f.root], stateRoot: join(f.home, "state-link") });
      expect(await linked.inspect({
        ...command(f.root), program: "/bin/cat", args: [join(storage, "key")],
      })).toBeNull();
      expect(await f.host.inspect({ ...command(f.root), program: "/usr/bin/du", args: [f.home] })).toBeNull();
      expect(calls).toHaveLength(0);
      const found = await broad.inspect({ ...command(f.home), program: "/usr/bin/find", args: [f.home, "-type", "f"] });
      expect(found?.exitCode).toBe(0);
      expect(found?.output).not.toContain(f.stateRoot);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("opaque hex and base64 secrets are redacted without hiding Git commit hashes", () => {
    for (const secret of ["a".repeat(64), "0123456789abcdef".repeat(4), "abcdEFGHijklMNOP01234567+/".repeat(3)])
      expect(redactHostText(`normal\n${secret}\nlast line`)).toBe("normal\n[REDACTED: sensitive text]\nlast line");
    expect(redactHostText(`${"a".repeat(40)} commit summary`)).toBe(`${"a".repeat(40)} commit summary`);
  });
  test("home app-data guards do not reserve ordinary project directory names", async () => {
    const f = fixture(async () => ok(""));
    try {
      for (const name of ["containers", "messages", "keys", "mail", "accounts", "safari", "chrome", ".config"]) {
        const directory = join(f.root, "src", name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "example.tsx"), "export const value = 1;");
        expect(await f.host.read(join(directory, "example.tsx"))).toMatchObject({ text: "export const value = 1;" });
        expect((await f.host.list(directory)).entries).toHaveLength(1);
        expect(f.host.validateCommand({ ...command(directory) }).cwd).toBe(directory);
        expect(await f.host.inspect({ ...command(directory), program: "/bin/ls", args: [directory] })).not.toBeNull();
      }
      mkdirSync(join(f.root, "private"));
      expect(f.host.validateCommand(command(join(f.root, "private"))).cwd).toBe(join(f.root, "private"));
      for (const path of ["Library/Mail", "Library/Messages", "Library/Containers", ".config"]) {
        const directory = join(f.home, path);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "example.txt"), "private");
        const broad = new MacHost({ home: f.home, roots: [f.home], stateRoot: f.stateRoot });
        await expect(broad.read(join(directory, "example.txt"))).rejects.toThrow("private");
        expect(await f.host.inspect({ ...command(f.root), program: "/bin/cat", args: [join(directory, "example.txt")] })).toBeNull();
      }
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("metadata inspection allows private-text directories without permitting their contents", async () => {
    const f = fixture(async (input) => ok(input.args.includes("config") ? "" : "metadata"));
    try {
      const directory = join(f.root, "notes");
      mkdirSync(directory);
      const file = join(directory, "entry.txt");
      writeFileSync(file, "private");
      for (const program of ["/bin/ls", "/usr/bin/du", "/usr/bin/find", "/usr/bin/stat", "/bin/df"])
        expect(await f.host.inspect({ ...command(f.root), program, args: [directory] })).not.toBeNull();
      expect(await f.host.inspect({
        ...command(f.root), program: "/usr/bin/git", args: ["-C", directory, "status"],
      })).not.toBeNull();
      expect(await f.host.inspect({ ...command(f.root), program: "/bin/cat", args: [file] })).toBeNull();
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("canonical argv expansion retains the original inspection shape and find pruning", async () => {
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok(""); });
    try {
      const deep = join(f.root, ...Array.from({ length: 8 }, () => "level".repeat(10)));
      mkdirSync(deep, { recursive: true });
      const result = await f.host.inspect({
        ...command(deep), program: "/usr/bin/find", args: [...Array<string>(60).fill("."), "-name", "*.log", "-print"],
      });
      expect(result).not.toBeNull();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args.join("").length).toBeGreaterThan(12_000);
      expect(calls[0]!.inspection).toBe(true);
      expect(calls[0]!.args).toContain("-prune");
      expect(calls[0]!.args).toContain("*-wal");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("launchctl print exposes status fields but no service environment or argument dump", async () => {
    const f = fixture(async () => ok("gui/501/dev.infra = {\n\tstate = running\n\tpid = 123\n\tenvironment = {\n\t\tOWNER_TOKEN => short-secret-value\n\t}\n\targuments = {\n\t\t--password\n\t\tanother-secret\n\t}\n\tlast exit code = 0\n}\n"));
    try {
      const result = await f.host.inspect({
        ...command(f.root), program: "/bin/launchctl", args: ["print", "gui/501/dev.infra"],
      });
      expect(result?.output).toContain("state = running");
      expect(result?.output).toContain("pid = 123");
      expect(result?.output).not.toContain("environment");
      expect(result?.output).not.toContain("short-secret-value");
      expect(result?.output).not.toContain("arguments");
      expect(result?.output).not.toContain("another-secret");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("ls-remote only reaches configured public HTTPS destinations or explicit GitHub repositories", async () => {
    let destination = "https://github.com/owner/repo.git";
    let rewrite = false;
    let proxy = false;
    const calls: HostRun[] = [];
    const f = fixture(async (input) => {
      calls.push(input);
      if (input.args.includes("--get-url"))
        return ok(`${rewrite && input.args.at(-1) === destination ? "https://127.0.0.1/private/repo" : destination}\n`);
      if (input.args.includes("config") && input.args.includes("--name-only") && !input.args.includes("--null"))
        return { ...ok(proxy ? "http.proxy\n" : ""), exitCode: proxy ? 0 : 1 };
      return ok(input.args.includes("config") ? "" : "refs/heads/main\n");
    });
    try {
      mkdirSync(join(f.root, ".git"));
      writeFileSync(join(f.root, ".git/config"), '[remote "origin"]\n url = https://github.com/owner/repo.git\n');
      for (const url of ["https://example.com/leak/repo", "https://127.0.0.1/private/repo", "https://localhost/private/repo"]) {
        expect(await f.host.inspect({ ...command(f.root), program: "/usr/bin/git", args: ["ls-remote", url] })).toBeNull();
      }
      expect(calls).toHaveLength(0);
      for (const url of ["https://127.0.0.1/repo", "https://[::1]/repo", "https://localhost/repo", "https://forge.local/repo", "https://forge.internal/repo", "https://token@github.com/owner/repo"]) {
        destination = url;
        expect(await f.host.inspect({ ...command(f.root), program: "/usr/bin/git", args: ["ls-remote", "origin"] })).toBeNull();
      }
      expect(calls.every((call) => call.args.includes("--get-url"))).toBe(true);
      destination = "https://github.com/owner/repo.git";
      rewrite = true;
      expect(await f.host.inspect({ ...command(f.root), program: "/usr/bin/git", args: ["ls-remote", "origin"] })).toBeNull();
      rewrite = false;
      proxy = true;
      expect(await f.host.inspect({ ...command(f.root), program: "/usr/bin/git", args: ["ls-remote", "origin"] })).toBeNull();
      proxy = false;
      const result = await f.host.inspect({ ...command(f.root), program: "/usr/bin/git", args: ["ls-remote", "origin"] });
      expect(result?.output).toContain("refs/heads/main");
      const requests = calls.filter((call) => call.args.includes("ls-remote") && !call.args.includes("--get-url"));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.args.at(-1)).toBe(destination);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("inspection classification accepts only fixed programs and read-only argv shapes", () => {
    const allowed: [string, string[]][] = [
      ["/bin/ls", ["-lah", "~/Backup/mirror"]],
      ["/bin/cat", ["~/Library/Logs/infra.log"]],
      ["/usr/bin/head", ["-n", "40", "infra.log"]],
      ["/usr/bin/tail", ["-n", "80", "infra.log"]],
      ["/usr/bin/wc", ["-l", "infra.log"]],
      ["/usr/bin/stat", ["-x", "infra.log"]],
      ["/usr/bin/file", ["-b", "infra.log"]],
      ["/usr/bin/du", ["-sh", "~/Backup/mirror"]],
      ["/usr/bin/find", ["~/Backup/mirror", "-type", "f", "-name", "*.log", "-print"]],
      ["/bin/df", ["-h"]],
      ["/bin/ps", ["-axo", "pid,pcpu,comm"]],
      ["/usr/bin/sw_vers", []],
      ["/usr/bin/uptime", []],
      ["/usr/bin/plutil", ["-p", "~/Library/LaunchAgents/infra.plist"]],
      ["/bin/launchctl", ["list"]],
      ["/bin/launchctl", ["print", "gui/501/dev.infra"]],
      ["/usr/bin/git", ["-C", "~/Backup/mirror", "--no-optional-locks", "status", "--short"]],
      ["/usr/bin/git", ["log", "-5", "--oneline"]],
      ["/usr/bin/git", ["show", "--stat", "HEAD"]],
      ["/usr/bin/git", ["diff", "--name-only", "--cached"]],
      ["/usr/bin/git", ["branch", "-av"]],
      ["/usr/bin/git", ["remote", "-v"]],
      ["/usr/bin/git", ["ls-remote", "--heads", "https://github.com/owner/repo.git"]],
      ["/usr/bin/git", ["ls-remote", "origin"]],
      ["/usr/bin/git", ["rev-parse", "--show-toplevel"]],
      ["/usr/bin/git", ["stash", "list"]],
      ["/usr/bin/git", ["config", "--get", "user.email"]],
    ];
    for (const [program, args] of allowed)
      expect(isReadOnlyHostCommand({ program, args })).toBe(true);
    const denied: [string, string[]][] = [
      ["/bin/sh", ["-c", "cat log"]],
      ["/usr/local/bin/cat", ["log"]],
      ["/usr/bin/curl", ["https://example.com"]],
      ["/bin/cat", ["log", ">", "result"]],
      ["/bin/cat", ["log;touch result"]],
      ["/bin/ls", ["-R", "."]],
      ["/usr/bin/tail", ["-f", "log"]],
      ["/usr/bin/head", ["-c", "52", "host.json"]],
      ["/usr/bin/tail", ["-c", "52", "host.json"]],
      ["/usr/bin/tail", ["-c52", "host.json"]],
      ["/usr/bin/git", ["ls-remote", "https://example.com/exfil/repo"]],
      ["/usr/bin/git", ["ls-remote", "https://127.0.0.1/private/repo"]],
      ["/usr/bin/git", ["ls-remote", "https://localhost/private/repo"]],
      ["/usr/bin/file", ["-C", "."]],
      ["/usr/bin/stat", ["-L", "."]],
      ["/usr/bin/du", ["-L", "."]],
      ["/bin/ps", ["auxe"]],
      ["/usr/bin/plutil", ["-replace", "Label", "-string", "changed", "agent.plist"]],
      ["/bin/launchctl", ["bootout", "gui/501/dev.infra"]],
      ...["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls", "-L"].map((flag): [string, string[]] =>
        ["/usr/bin/find", [".", flag, "file"]]),
      ...[
        ["-c", "core.fsmonitor=evil", "status"], ["--config-env=core.fsmonitor=EVIL", "status"],
        ["push"], ["fetch"], ["pull"], ["reset", "--hard"], ["checkout", "main"],
        ["branch", "-D", "main"], ["branch", "new"], ["remote", "set-url", "origin", "https://example.com/repo"],
        ["show", "HEAD:file"], ["diff", "--output=leak"], ["log", "--output=leak"], ["log", "--ext-diff"],
        ["stash", "pop"], ["config", "user.name", "changed"], ["config", "--get", "credential.helper"],
        ["config", "--get", "http.extraHeader"], ["ls-remote", "ext::touch result"], ["ls-remote", "file:///tmp/repo"],
      ].map((args): [string, string[]] => ["/usr/bin/git", args]),
    ];
    for (const [program, args] of denied)
      expect(isReadOnlyHostCommand({ program, args })).toBe(false);
  });
  test("home inspections cover operations paths, redact output and refuse sensitive paths and symlink escapes", async () => {
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok("healthy\npassword=hidden\n"); });
    const outside = realpathSync(tempDir());
    try {
      for (const directory of ["Library/Logs", ".local/state/infra", "Library/LaunchAgents", "Backup/mirror"]) {
        mkdirSync(join(f.home, directory), { recursive: true });
        const path = join(f.home, directory, "operations.log");
        writeFileSync(path, "healthy");
        const result = await f.host.inspect({
          ...command(f.root), program: "/bin/cat", cwd: join(f.home, directory), args: [path],
        });
        expect(result?.output).toBe("healthy\n[REDACTED: sensitive text]\n");
      }
      expect(calls).toHaveLength(4);
      expect(calls.every((call) => call.inspection && call.timeoutMs <= 90_000 && call.maxBytes === 24_000)).toBe(true);
      for (const sensitive of [
        ".ssh/id_ed25519", ".gnupg/pubring.kbx", ".aws/config", ".env.production",
        "Library/Keychains/login.keychain-db", "Library/Application Support/Google/Chrome/Default/Preferences",
        "Library/Mail/inbox.txt", "Library/Messages/chat.txt", "state/secrets/provider.json", "Library/Application Support/Ghost/vault/key",
        "private/record.txt", "notes/note.txt", ".git/config", ".git-credentials",
        "Documents/tax.pdf", "Desktop/scan.txt", "Downloads/statement.csv", "Library/CloudStorage/Drive/file.txt",
      ]) {
        const path = join(f.home, sensitive);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "private");
        expect(await f.host.inspect({
          ...command(f.root), program: "/bin/cat", args: [path],
        })).toBeNull();
      }
      writeFileSync(join(outside, "outside.log"), "outside");
      symlinkSync(join(outside, "outside.log"), join(f.root, "escape.log"));
      symlinkSync(join(f.home, ".env.production"), join(f.root, "innocent.log"));
      for (const path of [join(f.root, "escape.log"), join(f.root, "innocent.log")])
        expect(await f.host.inspect({
          ...command(f.root), program: "/bin/cat", args: [path],
        })).toBeNull();
      expect(await f.host.inspect({
        ...command(f.root), program: "/bin/ls", args: [], cwd: outside,
      })).toBeNull();
      expect(calls).toHaveLength(4);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  test("recursive inspection prunes sensitive entries and never follows descendant links", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "visible.log"), "healthy");
      mkdirSync(join(f.root, "Secrets"));
      writeFileSync(join(f.root, "Secrets", "hidden.log"), "hidden");
      writeFileSync(join(f.root, ".env.local"), "hidden");
      symlinkSync(join(f.root, "Secrets"), join(f.root, "linked"));
      const result = await f.host.inspect({
        ...command(f.root), program: "/usr/bin/find", args: [f.root, "-type", "f"],
      });
      expect(result?.exitCode).toBe(0);
      expect(result?.output).toContain("visible.log");
      expect(result?.output).not.toContain("hidden.log");
      expect(result?.output).not.toContain(".env.local");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("Git inspection disables configured filters, fsmonitor and external diff", async () => {
    const f = fixture();
    const git = (args: string[]) => Bun.spawnSync(["/usr/bin/git", "-C", f.root, ...args], {
      env: { PATH: "/usr/bin:/bin", HOME: f.home, LANG: "en_US.UTF-8" },
      stdout: "pipe", stderr: "pipe",
    });
    try {
      expect(git(["init"]).exitCode).toBe(0);
      writeFileSync(join(f.root, ".gitattributes"), "*.txt filter=unsafe\n");
      writeFileSync(join(f.root, "example.txt"), "before\n");
      expect(git(["add", "."]).exitCode).toBe(0);
      expect(git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]).exitCode).toBe(0);
      const marker = join(f.home, "executed");
      appendFileSync(join(f.root, ".git/config"), `\n[filter "unsafe"]\n clean = /usr/bin/touch ${marker}\n process = /usr/bin/touch ${marker}\n required = true\n[core]\n fsmonitor = /usr/bin/touch ${marker}\n[diff]\n external = /usr/bin/touch ${marker}\n`);
      writeFileSync(join(f.root, "example.txt"), "after\n");
      for (const args of [["status", "--short"], ["diff", "--stat"], ["log", "-1", "--stat"]]) {
        const result = await f.host.inspect({ ...command(f.root), program: "/usr/bin/git", args });
        expect(result?.exitCode).toBe(0);
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("Git inspection checks chained -C and repository metadata symlinks", async () => {
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok(""); });
    const outside = realpathSync(tempDir());
    try {
      mkdirSync(join(f.root, "child"));
      await f.host.inspect({
        ...command(f.home), program: "/usr/bin/git", args: ["-C", "projects", "-C", "child", "status"],
      });
      expect(calls.at(-1)?.args).toEqual(["-C", f.root, "-C", join(f.root, "child"), "status", "--ignore-submodules=all"]);
      symlinkSync(outside, join(f.root, ".git"));
      expect(await f.host.inspect({
        ...command(f.root), program: "/usr/bin/git", args: ["status"],
      })).toBeNull();
    } finally {
      rmSync(f.home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
  test("canonical roots reject traversal, escape, secrets and private text; symlinks never read", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "hello.txt"), "hello");
      writeFileSync(join(f.root, ".env.local"), "credential");
      mkdirSync(join(f.root, "notes"));
      writeFileSync(join(f.root, "notes", "one.txt"), "private");
      mkdirSync(join(f.home, "outside"));
      writeFileSync(join(f.home, "outside", "one.txt"), "outside");
      symlinkSync(join(f.home, "outside"), join(f.root, "escape"));
      symlinkSync(join(f.root, "hello.txt"), join(f.root, "alias"));
      symlinkSync(join(f.root, ".env.local"), join(f.root, "hidden"));
      expect(() => f.host.resolve(`${f.root}/../outside`)).toThrow("traversal");
      expect(() => f.host.resolve(join(f.root, "escape", "one.txt"))).toThrow(
        "escape",
      );
      expect(() => f.host.resolve(join(f.root, "hidden"))).toThrow("secret");
      expect(() => f.host.resolve(join(f.root, ".env.local"))).toThrow(
        "secret",
      );
      await expect(
        f.host.read(join(f.root, "notes", "one.txt")),
      ).rejects.toThrow("private");
      await expect(f.host.read(join(f.root, "alias"))).rejects.toThrow(
        "symlink",
      );
      expect(await f.host.read(join(f.root, "hello.txt"))).toMatchObject({
        text: "hello",
      });
      const listing = await f.host.list(f.root);
      expect(listing.entries.some((e) => e.name === ".env.local")).toBe(false);
      writeFileSync(join(f.home, ".cache", "text.txt"), "cache");
      expect(await f.host.read(join(f.home, ".cache", "text.txt"))).toMatchObject({ text: "cache" });
      expect(await f.host.list(join(f.home, ".cache"))).toMatchObject({
        entries: [{ name: "text.txt", kind: "file" }],
      });
      writeFileSync(join(f.root, "huge.txt"), "x".repeat(12_001));
      await expect(f.host.read(join(f.root, "huge.txt"))).rejects.toThrow(
        "12 KB",
      );
      writeFileSync(join(f.root, "binary.txt"), Buffer.from([0xff]));
      await expect(f.host.read(join(f.root, "binary.txt"))).rejects.toThrow();
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("project reads allow symlinked root ancestors but refuse symlinks below that root", async () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "hello.txt"), "hello");
      mkdirSync(join(f.root, "sub"));
      writeFileSync(join(f.root, "sub", "text.txt"), "sub");
      symlinkSync(f.home, join(f.home, "linked"));
      symlinkSync(join(f.root, "sub"), join(f.root, "alias-dir"));
      const linkedRoot = join(f.home, "linked", "projects");
      const host = new MacHost({ home: f.home, roots: [linkedRoot] });
      expect(await host.read(join(linkedRoot, "hello.txt"))).toMatchObject({
        text: "hello",
      });
      expect(await host.read(join(f.root, "hello.txt"))).toMatchObject({
        text: "hello",
      });
      await expect(
        host.read(join(linkedRoot, "alias-dir", "text.txt")),
      ).rejects.toThrow("symlink");
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("du totals come only from stdout, even when diagnostics arrive first", async () => {
    const f = fixture(async () => ({
      exitCode: 1,
      stdout: "scan notice\n12\tpath\n",
      stderr: "99 permission errors\n",
      output: "99 permission errors\nscan notice\n12\tpath\n",
      timedOut: false,
      truncated: false,
    }));
    try {
      expect(await f.host.diskUsage(f.root)).toMatchObject({
        bytes: 12 * 1024,
        partial: true,
      });
      const scan = await f.host.diskScan();
      expect(scan.entries.length).toBeGreaterThan(0);
      expect(
        scan.entries.every(
          (entry) => entry.bytes === 12 * 1024 && entry.partial,
        ),
      ).toBe(true);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test.skipIf(process.getuid?.() === 0 || Boolean(process.env.CI))(
    "real du preserves its partial total for unreadable subdirectories",
    async () => {
      let observed: HostOutput | undefined;
      const f = fixture(async (input) => {
        observed = await runHostCommand(input);
        return observed;
      });
      const locked = join(f.root, "blocked");
      try {
        mkdirSync(locked);
        writeFileSync(join(locked, "hidden.txt"), "not readable");
        writeFileSync(join(f.root, "visible.txt"), "visible");
        chmodSync(locked, 0);
        const usage = await f.host.diskUsage(f.root);
        expect(observed?.stderr).toMatch(/permission denied/i);
        expect(observed?.stdout).toMatch(/^\s*\d+\s/m);
        expect(usage.bytes).toBeGreaterThan(0);
        expect(usage.partial).toBe(true);
        const scan = await f.host.diskScan();
        expect(
          scan.entries.find((entry) => entry.path === f.root),
        ).toMatchObject({ partial: true });
      } finally {
        chmodSync(locked, 0o700);
        rmSync(f.home, { recursive: true, force: true });
      }
    },
  );
  test("openApp never starts host monitoring for doctor or import", async () => {
    const f = fixture();
    const start = spyOn(HostWatch.prototype, "start").mockImplementation(() => {
      throw new Error("only serve may start monitoring");
    });
    let app: App | undefined;
    try {
      writeFileSync(
        join(f.home, "config.json"),
        JSON.stringify({
          mac: { roots: [f.root], watch: { ghostId: "not-running" } },
        }),
      );
      app = await openApp(loadConfig({}, f.home));
      expect(start).not.toHaveBeenCalled();
      expect(app.ledger.setting("hostWatch", null)).toBeNull();
    } finally {
      await app?.close();
      start.mockRestore();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("sensitive text redacts credentials without removing ordinary evidence", () => {
    for (const value of [
      "GITHUB_TOKEN=ghp_example",
      "SECRET_KEY='example'",
      "passwd: value",
      "Bearer abc",
      "github_pat_example",
      "-----BEGIN PRIVATE KEY-----",
      "AbCdEfGhIjKlMnOpQrStUvWxYz012345678901234567890123",
    ])
      expect(sensitiveText(value)).toBe(true);
    expect(redactHostText("normal\npassword: xyz\nlast line")).toBe(
      "normal\n[REDACTED: sensitive text]\nlast line",
    );
    expect(sensitiveText("disk-cache secret management token budget")).toBe(
      false,
    );
  });
  test("absolute allowlist, canonical denylist, interpreters, metacharacters and cwd enforce preflight", () => {
    const f = fixture();
    try {
      expect(f.host.validateCommand(command(f.root)).program).toBe(
        realpathSync("/bin/echo"),
      );
      for (const program of [
        "echo",
        "/bin/sh",
        "/bin/bash",
        "/usr/bin/env",
        "/usr/bin/python3",
        "/usr/bin/sudo",
        "/usr/bin/security",
        "/usr/bin/osascript",
        "/usr/bin/ssh",
        "/bin/launchctl",
      ])
        expect(() =>
          f.host.validateCommand({ ...command(f.root), program }),
        ).toThrow();
      for (const arg of [
        "hello; rm file",
        "$(id)",
        "a|b",
        "a&&b",
        "`id`",
        "a\nb",
      ])
        expect(() =>
          f.host.validateCommand({ ...command(f.root), args: [arg] }),
        ).toThrow("metacharacter");
      expect(() =>
        f.host.validateCommand({
          ...command(f.root),
          cwd: join(f.home, ".cache"),
        }),
      ).toThrow("outside");
      symlinkSync("/bin/sh", join(f.root, "alias"));
      expect(() =>
        f.host.validateCommand({
          ...command(f.root),
          program: join(f.root, "alias"),
        }),
      ).toThrow("interpreter");
      const tool = join(f.root, "tool");
      writeFileSync(tool, "executable");
      chmodSync(tool, 0o700);
      expect(
        f.host.validateCommand({ ...command(f.root), program: tool }).program,
      ).toBe(tool);
      expect(() =>
        f.host.validateCommand({ ...command(f.root), title: "x".repeat(2001) }),
      ).toThrow();
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("fake runner receives fixed bounded probes; process names only, service states correct", async () => {
    const calls: HostRun[] = [];
    const f = fixture(async (input) => {
      calls.push(input);
      if (input.program.endsWith("memory_pressure"))
        return ok("System-wide memory free percentage: 42%\n");
      if (input.program.endsWith("ps"))
        return ok(
          "33.5 /Applications/Example.app/Example\n2.0 /usr/bin/other\n",
        );
      if (input.program.endsWith("lsof"))
        return ok(
          "a TCP *:3000 (LISTEN)\nb TCP [::]:3000 (LISTEN)\nc TCP *:4000 (LISTEN)\n",
        );
      if (input.program.endsWith("launchctl"))
        return ok("PID\tStatus\tLabel\n12\t0\tdev.running\n-\t7\tdev.failed\n");
      if (input.program.endsWith("plutil"))
        return ok(
          input.args.at(-1)!.includes("one")
            ? "dev.running"
            : input.args.at(-1)!.includes("two")
              ? "dev.failed"
              : "dev.unloaded",
        );
      return ok("1\tpath\n");
    });
    try {
      mkdirSync(join(f.home, "Library/LaunchAgents"));
      for (const name of ["one", "two", "three"])
        writeFileSync(
          join(f.home, "Library/LaunchAgents", `${name}.plist`),
          "",
        );
      const status = await f.host.status();
      expect(status.memoryFreePct).toBe(42);
      expect(status.topProcesses[0]).toEqual({ name: "Example", cpuPct: 33.5 });
      expect(status.listeningPortCount).toBe(2);
      expect(status.disks.map((d) => d.path)).toEqual(["/", f.root]);
      const services = await f.host.services();
      expect(services.failed.map((s) => s.label)).toEqual(["dev.failed"]);
      expect(services.services.map((s) => s.state).sort()).toEqual([
        "loaded",
        "running",
        "unloaded",
      ]);
      expect(calls.filter((c) => c.program.endsWith("launchctl"))).toHaveLength(
        1,
      );
      expect(
        calls.every(
          (c) => c.timeoutMs > 0 && c.maxBytes > 0 && c.home === f.home,
        ),
      ).toBe(true);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("disk scans include build children with at most four concurrent bounded du probes", async () => {
    let active = 0;
    let max = 0;
    const calls: HostRun[] = [];
    const f = fixture(async (input) => {
      calls.push(input);
      active++;
      max = Math.max(max, active);
      await Promise.resolve();
      active--;
      return ok("12\tpath\n");
    });
    try {
      for (let n = 0; n < 40; n++) {
        mkdirSync(join(f.root, `p${n}`));
        for (const child of [
          "target",
          "build",
          "node_modules",
          ".next",
          "dist",
        ])
          mkdirSync(join(f.root, `p${n}`, child));
      }
      const result = await f.host.diskScan();
      expect(calls.length).toBeLessThanOrEqual(180);
      expect(max).toBeLessThanOrEqual(4);
      expect(max).toBe(4);
      expect(result.entries.length).toBeLessThanOrEqual(20);
      expect(calls.some((c) => c.args.at(-1)?.endsWith("node_modules"))).toBe(
        true,
      );
      expect(calls.every((c) => c.timeoutMs <= 45_000)).toBe(true);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("runner kills process group on timeout, caps output, and scrubs inherited environment", async () => {
    // Real deadlines deliberately exercise OS process-group termination, not a simulated timer.
    const root = realpathSync(tempDir());
    try {
      const started = Date.now();
      const timed = await runHostCommand({
        program: "/bin/sh",
        args: ["-c", "sleep 30 & echo $!; wait"],
        cwd: root,
        home: root,
        timeoutMs: 100,
        maxBytes: 100,
      });
      expect(timed.timedOut).toBe(true);
      expect(Date.now() - started).toBeLessThan(3000);
      const pid = Number(timed.output.trim());
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      const huge = await runHostCommand({
        program: "/usr/bin/yes",
        args: ["abcdef"],
        cwd: root,
        home: root,
        timeoutMs: 50,
        maxBytes: 100,
      });
      expect(Buffer.byteLength(huge.output)).toBeLessThanOrEqual(100);
      expect(huge.truncated).toBe(true);
      const environment = await runHostCommand({
        program: "/usr/bin/env",
        args: [],
        cwd: root,
        home: root,
        timeoutMs: 1000,
        maxBytes: 4000,
      });
      expect(
        environment.output
          .trim()
          .split("\n")
          .every((line) => /^(PATH|HOME|LANG)=/.test(line)),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("mac configuration coexists with API host and expands roots", () => {
    const root = tempDir();
    try {
      writeFileSync(
        join(root, "config.json"),
        JSON.stringify({
          host: "127.0.0.1",
          mac: {
            roots: ["~/Workspace/Projects"],
            watch: { ghostId: "watcher", intervalMinutes: 5 },
          },
        }),
      );
      const config = loadConfig({}, root);
      expect(config.host).toBe("127.0.0.1");
      expect(config.mac?.roots[0]).not.toContain("~");
      writeFileSync(
        join(root, "config.json"),
        JSON.stringify({
          mac: { roots: [], watch: { ghostId: "a", intervalMinutes: 0 } },
        }),
      );
      expect(() => loadConfig({}, root)).toThrow("mac.watch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("host command approval", () => {
  test("inspection path refusals and byte-sliced reads fall through to owner approval", async () => {
    const h = harness();
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok("approved"); });
    try {
      const ghost = h.core.createGhost({ name: "Mac", persona: "", tools: ["host_command_propose"] });
      const conversation = h.ledger.conversation(ghost.directConversationId);
      h.ledger.setPiConversationId(conversation.id, "pi-host-fallback");
      const tool = createHostTools(h.core, f.host).tools!.find((candidate) => candidate.name === "host_command_propose")!;
      const invoke = tool.execute as unknown as (input: HostCommand, api: ToolExecutionApi) => Promise<unknown>;
      const cases: [string, string[]][] = [
        ["/bin/ls", ["/etc"]], ["/bin/cat", ["/etc/hosts"]],
        ["/usr/bin/head", ["-c", "52", "/etc/hosts"]], ["/usr/bin/tail", ["-c", "52", "/etc/hosts"]],
        ["/usr/bin/tail", ["-c", "52", join(f.root, "source.txt")]],
        ["/usr/bin/tail", ["-c52", join(f.root, "source.txt")]],
      ];
      for (const [index, [program, args]] of cases.entries()) {
        await invoke({ ...command(f.root), program, args }, {
          conversationId: "pi-host-fallback", callId: `fallback-${index}`,
        } as unknown as ToolExecutionApi);
        expect(calls).toHaveLength(0);
        const decision = h.ledger.pendingDecisions()[0]!;
        expect(decision.kind).toBe("approve_effect");
        await h.core.effects.resolveApproval(decision.effectId!, false);
      }
    } finally {
      h.ledger.close();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("an existing command grant inspects without effects or decisions, while mutations still await approval", async () => {
    const h = harness();
    const calls: HostRun[] = [];
    const f = fixture(async (input) => { calls.push(input); return ok("observed"); });
    try {
      const ghost = h.core.createGhost({ name: "Mac", persona: "", tools: ["host_command_propose"] });
      const conversation = h.ledger.conversation(ghost.directConversationId);
      h.ledger.setPiConversationId(conversation.id, "pi-host-inspect");
      const extension = createHostTools(h.core, f.host);
      const tool = extension.tools!.find((candidate) => candidate.name === "host_command_propose")!;
      const invoke = tool.execute as unknown as (
        input: HostCommand, api: ToolExecutionApi,
      ) => Promise<unknown>;
      const api = (callId: string) => ({
        conversationId: "pi-host-inspect", callId,
      }) as unknown as ToolExecutionApi;
      const logs = join(f.home, "Library/Logs");
      mkdirSync(logs);
      const path = join(logs, "infra.log");
      writeFileSync(path, "observed");
      const before = h.ledger.seq();
      const result = await invoke({
        ...command(logs), program: "/bin/cat", args: [path],
      }, api("inspect"));
      expect(JSON.stringify(result)).toContain("observed");
      expect(calls).toHaveLength(1);
      expect(h.ledger.pendingDecisions()).toHaveLength(0);
      expect(h.ledger.effectByCall(conversation.id, "inspect")).toBeNull();
      expect(h.ledger.seq()).toBe(before);
      await expect(invoke({
        ...command(logs), program: "/bin/cat", args: [path, ">", "copied.log"],
      }, api("redirection"))).rejects.toThrow("shell metacharacter");
      expect(calls).toHaveLength(1);
      expect(h.ledger.pendingDecisions()).toHaveLength(0);
      await invoke({
        ...command(f.root), program: "/bin/rm", args: [path], risk: "Deletes the log",
      }, api("mutate"));
      expect(calls).toHaveLength(1);
      const decision = h.ledger.pendingDecisions()[0]!;
      expect(decision.kind).toBe("approve_effect");
      expect(h.ledger.effectByCall(conversation.id, "mutate")?.state).toBe("pending");
      await h.core.effects.resolveApproval(decision.effectId!, true);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.inspection).toBe(false);
    } finally {
      h.ledger.close();
      rmSync(f.home, { recursive: true, force: true });
    }
  });
  test("proposal opens approve_effect, never executes until approval; expired effects are denied", async () => {
    const h = harness();
    const probes = new Probes();
    const ghost = h.core.createGhost({
      name: "Mac",
      persona: "",
      tools: [...HOST_TOOLS],
    });
    const conversation = h.ledger.conversation(ghost.directConversationId);
    const extension = createHostTools(h.core, probes);
    const tool = extension.tools!.find(
      (t) => t.name === "host_command_propose",
    )!;
    h.ledger.setPiConversationId(conversation.id, "pi-host-test");
    const api = (callId: string) =>
      ({
        conversationId: "pi-host-test",
        callId,
      }) as unknown as ToolExecutionApi;
    const invoke = tool.execute as unknown as (
      input: HostCommand,
      api: ToolExecutionApi,
    ) => Promise<unknown>;
    await invoke(command("/project"), api("first"));
    const decision = h.ledger.pendingDecisions()[0]!;
    expect(decision.kind).toBe("approve_effect");
    expect(decision.proposal).toMatchObject({
      title: "Check",
      cwd: "/project",
      reason: "Inspect explicitly",
    });
    expect(probes.executions).toBe(0);
    await h.core.effects.resolveApproval(decision.effectId!, true);
    expect(probes.executions).toBe(1);
    expect(h.ledger.effect(decision.effectId!).state).toBe("done");
    await invoke(command("/project"), api("expired"));
    const expired = h.ledger
      .pendingDecisions()
      .find((d) => d.effectId !== decision.effectId)!;
    const effect = h.ledger.effect(expired.effectId!);
    const clock = spyOn(Date, "now").mockReturnValue(
      effect.createdAt + 24 * HOUR + 1,
    );
    try {
      await h.core.effects.resolveApproval(effect.id, true);
      expect(probes.executions).toBe(1);
      expect(h.ledger.effect(effect.id).state).toBe("denied");
    } finally {
      clock.mockRestore();
    }
    h.ledger.close();
  });
});

describe("HostWatch durable admission", () => {
  test("baseline, restarted streaks, cooldown and daily review persist before one deterministic submission", async () => {
    const h = harness();
    const probes = new Probes();
    const ghost = h.core.createGhost({ name: "Watch", persona: "" });
    const watch = new HostWatch(h.core, probes, { ghostId: ghost.id });
    const original = h.engine.submit.bind(h.engine);
    h.engine.submit = async (id, submission) => {
      const state = h.ledger.setting<{ pending: { requestId: string }[] }>(
        "hostWatch",
        { pending: [] },
      );
      expect(
        state.pending.some((p) => p.requestId === submission.requestId),
      ).toBe(true);
      await original(id, submission);
    };
    const start = 100 * HOUR;
    await watch.tick(start);
    expect(
      h.engine.to(ghost.directConversationId).map((s) => s.requestId),
    ).toEqual([`hostwatch:${start}`]);
    probes.free = 40 * GB;
    await watch.tick(start + 5 * 60_000);
    expect(h.engine.submissions.size).toBe(1);
    await watch.tick(start + 10 * 60_000);
    expect(h.engine.submissions.size).toBe(2);
    const pressure = h.engine.to(ghost.directConversationId)[1]!;
    expect(pressure.requestId).toBe(`hostwatch:${start + 10 * 60_000}`);
    expect(pressure.text).toContain(":pressure");
    expect(pressure.text).toContain("NO_UPDATE");
    const restarted = new HostWatch(h.core, probes, { ghostId: ghost.id });
    await restarted.tick(start + 7 * HOUR);
    expect(h.engine.submissions.size).toBe(2); // A continuing incident is not new after six hours.
    probes.free = 100 * GB;
    await restarted.tick(start + 7 * HOUR + 5 * 60_000);
    probes.free = 40 * GB;
    await restarted.tick(start + 7 * HOUR + 10 * 60_000);
    await restarted.tick(start + 7 * HOUR + 15 * 60_000);
    expect(h.engine.submissions.size).toBe(3); // Resolved and reappeared after cooldown.
    probes.free = 100 * GB;
    await restarted.tick(start + 7 * HOUR + 20 * 60_000);
    probes.free = 40 * GB;
    await restarted.tick(start + 7 * HOUR + 25 * 60_000);
    await restarted.tick(start + 7 * HOUR + 30 * 60_000);
    expect(h.engine.submissions.size).toBe(3); // Reappeared inside cooldown.
    await restarted.tick(start + 14 * HOUR);
    expect(h.engine.submissions.size).toBe(3); // No delayed re-admission for that same streak.
    await restarted.tick(start + 24 * HOUR);
    expect(h.engine.submissions.has(`hostwatch:${start + 24 * HOUR}`)).toBe(
      true,
    );
    for (let i = 1; i < 15; i++)
      await restarted.tick(start + 24 * HOUR + i * 60_000);
    expect(
      h.ledger.setting<{ samples: unknown[] }>("hostWatch", { samples: [] })
        .samples.length,
    ).toBe(12);
    h.ledger.close();
  });
  test("critical is immediate; service and node issues need confirmation and coalesce", async () => {
    const h = harness();
    const probes = new Probes();
    const ghost = h.core.createGhost({ name: "Watch", persona: "" });
    const watch = new HostWatch(h.core, probes, { ghostId: ghost.id });
    const start = 100 * HOUR;
    await watch.tick(start);
    probes.free = 4 * GB;
    probes.lastExit = 7;
    probes.online = false;
    await watch.tick(start + 60_000);
    expect(h.engine.submissions.size).toBe(2);
    expect(h.engine.to(ghost.directConversationId)[1]!.text).toContain(
      ":critical",
    );
    expect(h.engine.to(ghost.directConversationId)[1]!.text).not.toContain(
      "service:",
    );
    expect(h.engine.to(ghost.directConversationId)[1]!.text).not.toContain(
      "node:",
    );
    await watch.tick(start + 2 * 60_000);
    expect(h.engine.submissions.size).toBe(3);
    const confirmed = h.engine.to(ghost.directConversationId)[2]!;
    expect(confirmed.requestId).toBe(`hostwatch:${start + 2 * 60_000}`);
    expect(confirmed.text).toContain("service:");
    expect(confirmed.text).toContain("node:");
    await watch.tick(start + 7 * HOUR);
    expect(h.engine.submissions.size).toBe(3);
    probes.free = 100 * GB;
    probes.lastExit = 0;
    probes.online = true;
    await watch.tick(start + 7 * HOUR + 10 * 60_000);
    probes.lastExit = 7;
    probes.online = false;
    await watch.tick(start + 7 * HOUR + 15 * 60_000);
    expect(h.engine.submissions.size).toBe(3);
    await watch.tick(start + 7 * HOUR + 20 * 60_000);
    expect(h.engine.submissions.size).toBe(4);
    h.ledger.close();
  });
  test("growth requires two consecutive samples at least thirty minutes after a reference", async () => {
    const h = harness();
    const probes = new Probes();
    const ghost = h.core.createGhost({ name: "Watch", persona: "" });
    const watch = new HostWatch(h.core, probes, { ghostId: ghost.id });
    const start = 100 * HOUR;
    await watch.tick(start);
    probes.free = 94 * GB;
    await watch.tick(start + HOUR / 2);
    expect(h.engine.submissions.size).toBe(1);
    probes.free = 93 * GB;
    await watch.tick(start + 35 * 60_000);
    expect(h.engine.submissions.size).toBe(2);
    expect(h.engine.to(ghost.directConversationId)[1]!.text).toContain(
      ":growth",
    );
    h.ledger.close();
  });
  test("volume identity deduplicates root paths but not independent disks with equal capacity", async () => {
    const h = harness();
    const probes = new Probes();
    const status = probes.status.bind(probes);
    probes.status = async () => {
      const sample = await status();
      return {
        ...sample,
        disks: [
          sample.disks[0]!,
          { ...sample.disks[0]!, path: "/projects" },
          { ...sample.disks[0]!, path: "/external", volumeId: "external" },
        ],
      };
    };
    const ghost = h.core.createGhost({ name: "Watch", persona: "" });
    const watch = new HostWatch(h.core, probes, { ghostId: ghost.id });
    const start = 100 * HOUR;
    await watch.tick(start);
    probes.free = 40 * GB;
    await watch.tick(start + 5 * 60_000);
    await watch.tick(start + 10 * 60_000);
    const state = h.ledger.setting<{
      samples: { disks: unknown[] }[];
      cooldowns: Record<string, number>;
    }>("hostWatch", { samples: [], cooldowns: {} });
    expect(state.samples.at(-1)!.disks).toHaveLength(2);
    expect(Object.keys(state.cooldowns)).toHaveLength(2);
    expect(h.engine.submissions.size).toBe(2); // Both confirmed volumes share one submission.
    expect(
      h.engine.to(ghost.directConversationId)[1]!.text.match(/:pressure/g),
    ).toHaveLength(2);
    h.ledger.close();
  });
  test("transient failures retain admission identities without freezing samples; retired/deleted Ghosts stay quiet", async () => {
    const h = harness();
    const probes = new Probes();
    const ghost = h.core.createGhost({ name: "Watch", persona: "" });
    const watch = new HostWatch(h.core, probes, { ghostId: ghost.id });
    const start = 100 * HOUR;
    const submit = h.engine.submit.bind(h.engine);
    h.engine.submit = async () => {
      throw new Error("offline");
    };
    await watch.tick(start);
    await watch.tick(start + 5 * 60_000);
    const pending = h.ledger.setting<{
      pending: { requestId: string }[];
      samples: unknown[];
    }>("hostWatch", { pending: [], samples: [] });
    expect(pending.pending.map((p) => p.requestId)).toEqual([
      `hostwatch:${start}`,
    ]);
    expect(pending.samples).toHaveLength(2);
    expect(probes.statusCalls).toBe(2);
    h.engine.submit = submit;
    await new HostWatch(h.core, probes, { ghostId: ghost.id }).tick(
      start + 10 * 60_000,
    );
    expect(h.engine.submissions.has(`hostwatch:${start}`)).toBe(true);
    h.ledger.tx(() =>
      h.ledger.putGhost({ ...h.ledger.ghost(ghost.id), state: "retired" }),
    );
    probes.free = 1 * GB;
    await watch.tick(start + 2 * HOUR);
    expect(h.engine.submissions.size).toBe(1);
    h.ledger.tx(() =>
      h.ledger.putGhost({
        ...h.ledger.ghost(ghost.id),
        state: "active",
        deletedAt: start,
      }),
    );
    await watch.tick(start + 24 * HOUR);
    expect(h.engine.submissions.size).toBe(1);
    expect(probes.statusCalls).toBe(5);
    h.ledger.close();
  });
  test("unavailable model admissions are dropped while later samples and new issues continue", async () => {
    const h = harness();
    const probes = new Probes();
    const ghost = h.core.createGhost({ name: "Watch", persona: "" });
    const watch = new HostWatch(h.core, probes, { ghostId: ghost.id });
    const submit = h.engine.submit.bind(h.engine);
    let attempts = 0;
    h.engine.submit = async () => {
      attempts++;
      throw new CommandError("unavailable", "no credential");
    };
    const start = 100 * HOUR;
    await watch.tick(start);
    probes.free = 40 * GB;
    await watch.tick(start + 5 * 60_000);
    await watch.tick(start + 10 * 60_000);
    const state = h.ledger.setting<{ pending: unknown[]; samples: unknown[] }>(
      "hostWatch",
      { pending: [], samples: [] },
    );
    expect(attempts).toBe(2);
    expect(state.pending).toHaveLength(0);
    expect(state.samples).toHaveLength(3);
    h.engine.submit = submit;
    probes.free = 1 * GB;
    await watch.tick(start + 15 * 60_000);
    expect(h.engine.submissions.size).toBe(1);
    expect(h.engine.submissions.has(`hostwatch:${start + 15 * 60_000}`)).toBe(
      true,
    );
    h.ledger.close();
  });
});
