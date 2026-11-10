import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_TOOLS } from "@ghost/contract";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { GhostControl } from "../src/integrations/desktop.ts";
import type { DesktopPort, DesktopResult } from "../src/integrations/ports.ts";
import { createDesktopTools } from "../src/tools/desktop.ts";
import { harness, tempDir } from "./support.ts";

const ok = (data: unknown): DesktopResult => ({ ok: true, data, error: null, delivered: true });
const tree = (send = "Send", id = "sabc") => ({ role: "window", name: "Doc", children: [
  { role: "button", name: "Save", ref_id: `@${id}:e1` },
  { role: "button", name: send, ref_id: `@${id}:e2` },
  { role: "textfield", name: "Body", ref_id: `@${id}:e3`, value: "Draft" },
] });

function fakeDesktop() {
  const calls: { runtime: "agent-desktop" | "geist"; argv: string[]; args?: Record<string, unknown>; stdin?: string }[] = [];
  const state = {
    idle: 60, tree: tree(), snapshotId: "sabc", processInstance: "macos-proc-v1:1:2", extraInstance: false, windowVisible: true, windowAccessible: true, protectedScreen: false,
    staleRefs: new Set<string>(),
    beforeDispatch: null as null | ((runtime: "agent-desktop" | "geist", command: string) => void),
  };
  const retained = new Map<string, { role: string; name: string }>();
  const port: DesktopPort = {
    async agentDesktop(argv, options) {
      state.beforeDispatch?.("agent-desktop", argv[0]!);
      options?.authorize?.();
      calls.push({ runtime: "agent-desktop", argv, stdin: options?.stdin });
      if (argv[0] === "list-apps") return ok([
        { name: "TextEdit", bundle_id: "com.apple.TextEdit", pid: 10, process_instance: state.processInstance, presentation: "regular" },
        { name: "Ghost", bundle_id: "dev.projectoxi.ghost", pid: 11, presentation: "regular" },
        ...(state.extraInstance ? [{ name: "TextEdit", bundle_id: "com.apple.TextEdit", pid: 12, process_instance: `${state.processInstance}:12`, presentation: "regular" }] : []),
      ]);
      if (argv[0] === "list-windows") return ok([
        { id: "w-100", pid: 10, process_instance: state.processInstance, title: "Doc", visible: state.windowVisible, accessible: state.windowAccessible },
        { id: "w-200", pid: 11, title: "Ghost", visible: true },
        ...(state.extraInstance ? [{ id: "w-101", pid: 12, process_instance: `${state.processInstance}:12`, title: "Other Doc", visible: true }] : []),
      ]);
      const session = argv[argv.indexOf("--session") + 1];
      if (argv[0] === "snapshot") {
        for (const node of state.tree.children) retained.set(`${session}:${node.ref_id}`, { role: node.role, name: node.name });
        return ok({ app: "TextEdit", snapshot_id: state.snapshotId, window: { id: "w-100" }, tree: state.tree, complete: true });
      }
      if (argv[0] === "get" || (argv[0] === "click" && state.staleRefs.has(argv[1]!))) {
        const element = retained.get(`${session}:${argv[1]}`);
        if (!element || state.staleRefs.has(argv[1]!)) return { ok: false, data: null, error: { code: "STALE_REF", message: "Original object was removed" }, delivered: false };
        return ok({ value: argv[argv.indexOf("--property") + 1] === "role" ? element.role : element.name });
      }
      return ok({});
    },
    async geist(tool, args, options) {
      state.beforeDispatch?.("geist", tool);
      options?.authorize?.();
      calls.push({ runtime: "geist", argv: [tool], args });
      if (tool === "get_app_state") return ok({
        snapshot_id: `screen-${calls.length}`, app: { bundle_id: "com.apple.TextEdit", pid: Number(String(args.app).slice(4)) },
        window: { id: args.window_id, title: "Doc", bounds: { x: 100, y: 50, width: 800, height: 600 } },
        image: { data: "iVBORw0KGgo=", width: 1600, height: 1200 },
        nodes: [
          { title: "Delete", description: "", value: null, bounds: { x: 500, y: 350, width: 100, height: 40 } },
          ...(state.protectedScreen ? [{ role: "AXSecureTextField", title: "Password", value: null, bounds: { x: 200, y: 100, width: 100, height: 30 } }] : []),
        ],
      });
      return ok({});
    },
    async status() { return { accessibility: true, screenRecording: true, idleSeconds: state.idle }; },
    async image() { return { data: "scaled", mimeType: "image/jpeg", width: 400, height: 300 }; },
    async shutdown() {},
  };
  return { port, calls, state };
}

function fixture() {
  const h = harness();
  const desktop = fakeDesktop();
  const extension = createDesktopTools(h.core, desktop.port);
  const ghost = h.core.createGhost({ name: "Operator", persona: "" });
  h.ledger.tx(() => h.ledger.putGhost({ ...ghost, tools: [...DESKTOP_TOOLS], hostExecution: true }));
  h.ledger.setPiConversationId(ghost.directConversationId, "pi-desktop");
  const other = h.core.createGhost({ name: "Other", persona: "" });
  h.ledger.tx(() => h.ledger.putGhost({ ...other, tools: [...DESKTOP_TOOLS], hostExecution: true }));
  h.ledger.setPiConversationId(other.directConversationId, "pi-other");
  let seq = 0;
  const call = async (name: string, args: unknown = {}, pi = "pi-desktop", callId = `call-${++seq}`, abortSignal?: AbortSignal): Promise<ToolExecutionResult> => {
    const tool = extension.tools!.find((t) => t.name === name)!;
    return tool.execute(args as never, { conversationId: pi, callId } as unknown as ToolExecutionApi, { abortSignal } as Context);
  };
  const said = (result: ToolExecutionResult) => (result.content ?? []).map((part) => part.type === "text" ? part.text : "").join("\n");
  return { ...h, ...desktop, ghost, call, said };
}

describe("PC control tools", () => {
  test("need the owner's PC execution grant and never observe Ghost itself", async () => {
    const f = fixture();
    f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), hostExecution: false }));
    const refused = await f.call("desktop_apps");
    expect(refused.isError).toBe(true);
    expect(f.said(refused)).toContain("PC 직접 실행");
    expect(f.calls).toHaveLength(0);

    f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), hostExecution: true }));
    const apps = f.said(await f.call("desktop_apps"));
    expect(apps).toContain("TextEdit");
    expect(apps).not.toContain("projectoxi");
    const ghost = await f.call("desktop_snapshot", { app: "Ghost" });
    expect(f.said(ghost)).toContain("outside PC control");
    expect(f.calls.some((c) => c.argv[0] === "snapshot")).toBe(false);
    expect(f.said(await f.call("desktop_snapshot", { app: "TextEdit", window_id: "w-200" }))).toContain("does not belong");
  });

  test("refs act only in the conversation that observed them; sending goes to the owner", async () => {
    const f = fixture();
    expect(f.said(await f.call("desktop_snapshot", { app: "TextEdit" }))).toContain('button "Send" @sabc:e2');
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e1" }))).toBe("Clicked");
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e2" }))).toContain("desktop_propose");
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e1" }, "pi-other"))).toContain("not from a desktop_snapshot of this conversation");
    await f.call("desktop_fill", { ref: "@sabc:e3", text: "--app Ghost" });
    expect(f.calls.filter((c) => c.argv[0] === "click").map((c) => c.argv.slice(0, 2))).toEqual([["click", "@sabc:e1"]]);
    // Text travels on stdin, never as an argument agent-desktop could read as a flag.
    expect(f.calls.find((c) => c.argv[0] === "set-value")).toMatchObject({ stdin: "--app Ghost" });
    expect(f.said(await f.call("desktop_press", { app: "TextEdit", keys: "return" }))).toBe("Key sent");
  });

  test("physical input maps image pixels to window points and uses each screen once", async () => {
    const f = fixture();
    const screenId = () => /screen_id (\S+):/.exec(f.said(lastScreenshot))![1]!;
    let lastScreenshot = await f.call("desktop_screenshot", { app: "TextEdit" });
    expect(lastScreenshot.content?.some((part) => part.type === "image")).toBe(true);
    // The 400×300 image of an 800×600 window: image pixels are half a window point.
    expect(f.said(await f.call("desktop_pointer", { screen_id: screenId(), action: "double_click", x: 10, y: 20, modifiers: "cmd" }))).toBe("Pointer double_click delivered");
    expect(f.calls.filter((c) => c.argv[0] === "click").at(-1)!.args).toMatchObject({ app: "pid:10", headed: true, x: 20, y: 40, click_count: 2, key: "super" });
    expect(f.said(await f.call("desktop_pointer", { screen_id: screenId(), action: "click", x: 10, y: 20 }))).toContain("used or expired");

    lastScreenshot = await f.call("desktop_screenshot", { app: "TextEdit" });
    // "Delete" spans window points 400–500 × 300–340, image pixels 200–250 × 150–170.
    expect(f.said(await f.call("desktop_pointer", { screen_id: screenId(), action: "click", x: 210, y: 160 }))).toContain("desktop_propose");
    lastScreenshot = await f.call("desktop_screenshot", { app: "TextEdit" });
    expect((await f.call("desktop_keys", { screen_id: screenId(), key: "cmd+q" })).isError).toBe(true);
    expect(f.calls.filter((c) => c.runtime === "geist" && c.argv[0] !== "get_app_state")).toHaveLength(1);
  });

  test("approval uses the original retained ref, never a fresh lookalike", async () => {
    const f = fixture();
    await f.call("desktop_snapshot", { app: "TextEdit" });
    const args = { ref: "@sabc:e2", title: "보내기", reason: "Reviewed draft" };
    await f.call("desktop_propose", args, "pi-desktop", "approval");
    let decision = f.ledger.pendingDecisions()[0]!;
    expect(decision.detail).toContain("button: Send");
    f.state.tree = tree("Send", "sdef"); f.state.snapshotId = "sdef";
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.ledger.effect(decision.effectId!).state).toBe("done");
    expect(f.calls.filter((c) => c.argv[0] === "click").map((c) => c.argv.slice(0, 2))).toEqual([["click", "@sabc:e2"]]);
    expect(f.calls.filter((c) => c.argv[0] === "snapshot")).toHaveLength(1);
    await f.call("desktop_screenshot", { app: "TextEdit" }); // Original host refs are now invalidated.
    expect(f.said(await f.call("desktop_propose", args, "pi-desktop", "approval"))).toBe("Approved click performed");
    expect(f.said(await f.call("desktop_propose", { ...args, reason: "Changed" }, "pi-desktop", "approval"))).toContain("different input");

    await f.call("desktop_snapshot", { app: "TextEdit" });
    await f.call("desktop_propose", { ...args, ref: "@sdef:e2" });
    decision = f.ledger.pendingDecisions()[0]!;
    f.state.tree = tree("Send", "sghi"); f.state.snapshotId = "sghi";
    f.state.staleRefs.add("@sdef:e2");
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(f.calls.filter((c) => c.argv[0] === "click")).toHaveLength(1);
  });

  test("queued revocation refuses delivery and records NoEffect, including approval", async () => {
    const f = fixture();
    await f.call("desktop_snapshot", { app: "TextEdit" });
    const revoke = () => f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), hostExecution: false }));
    f.state.beforeDispatch = (runtime, command) => { if (runtime === "agent-desktop" && command === "click") revoke(); };
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e1" }, "pi-desktop", "revoked"))).toContain("PC 직접 실행");
    expect(f.ledger.effectByCall(f.ghost.directConversationId, "revoked")?.state).toBe("denied");
    expect(f.calls.some((c) => c.argv[0] === "click")).toBe(false);
    f.state.beforeDispatch = null;
    f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), hostExecution: true }));
    await f.call("desktop_propose", { ref: "@sabc:e2", title: "Send", reason: "Reviewed" });
    const decision = f.ledger.pendingDecisions()[0]!;
    f.state.beforeDispatch = (runtime, command) => { if (runtime === "agent-desktop" && command === "click") revoke(); };
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(f.calls.some((c) => c.argv[0] === "click")).toBe(false);
  });

  for (const revoked of ["scope", "deadline", "state"] as const) {
    test(`approval rechecks live Work ${revoked} before delivery`, async () => {
      const f = fixture();
      const work = f.core.works.createRoot({ ghostId: f.ghost.id, originConversationId: f.ghost.directConversationId, title: "Send document", brief: "Review then send" });
      await f.core.idle();
      const running = f.ledger.work(work.id);
      f.ledger.setPiConversationId(running.conversationId!, "pi-work");
      await f.call("desktop_snapshot", { app: "TextEdit" }, "pi-work");
      await f.call("desktop_propose", { ref: "@sabc:e2", title: "Send", reason: "Reviewed" }, "pi-work");
      const decision = f.ledger.pendingDecisions().find((d) => d.kind === "approve_effect")!;
      f.ledger.tx(() => {
        const current = f.ledger.work(work.id);
        if (revoked === "scope") f.ledger.putWork({ ...current, toolScope: ["desktop_snapshot"] });
        if (revoked === "deadline") f.ledger.putWork({ ...current, deadlineAt: Date.now() - 1 });
        if (revoked === "state") f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), state: "retired" });
      });
      await f.core.decisions.resolve(decision.id, { outcome: "approve" });
      expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
      expect(f.calls.some((c) => c.argv[0] === "click")).toBe(false);
    });
  }

  test("a cancelled queued call never delivers input", async () => {
    const f = fixture();
    const controller = new AbortController();
    await f.call("desktop_snapshot", { app: "TextEdit" });
    f.state.beforeDispatch = (runtime, command) => { if (runtime === "agent-desktop" && command === "click") controller.abort(); };
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e1" }, "pi-desktop", "cancelled-click", controller.signal))).toContain("cancelled");
    expect(f.ledger.effectByCall(f.ghost.directConversationId, "cancelled-click")?.state).toBe("denied");
    expect(f.calls.some((c) => c.argv[0] === "click")).toBe(false);
  });

  test("approval refuses a restarted process even when its pid and window are reused", async () => {
    const f = fixture();
    await f.call("desktop_snapshot", { app: "TextEdit", window_id: "w-100" });
    await f.call("desktop_propose", { ref: "@sabc:e2", title: "Send", reason: "Reviewed" });
    const decision = f.ledger.pendingDecisions()[0]!;
    f.state.processInstance = "macos-proc-v1:later:2";
    await f.core.decisions.resolve(decision.id, { outcome: "approve" });
    expect(f.ledger.effect(decision.effectId!).state).toBe("denied");
    expect(f.calls.some((c) => c.argv[0] === "click")).toBe(false);
  });

  test("physical queued revocation cannot send input", async () => {
    const f = fixture();
    const shot = await f.call("desktop_screenshot", { app: "TextEdit" });
    const id = /screen_id (\S+):/.exec(f.said(shot))![1]!;
    f.state.beforeDispatch = (runtime, command) => {
      if (runtime === "geist" && command === "type_text") f.ledger.tx(() => f.ledger.putGhost({ ...f.ledger.ghost(f.ghost.id), hostExecution: false }));
    };
    expect(f.said(await f.call("desktop_keys", { screen_id: id, text: "Hello" }, "pi-desktop", "queued-keys"))).toContain("PC 직접 실행");
    expect(f.ledger.effectByCall(f.ghost.directConversationId, "queued-keys")?.state).toBe("denied");
    expect(f.calls.some((c) => c.argv[0] === "type_text")).toBe(false);
  });

  test("ambiguous app instances require a window and screenshots target its exact pid", async () => {
    const f = fixture();
    f.state.extraInstance = true;
    expect(f.said(await f.call("desktop_screenshot", { app: "TextEdit" }))).toContain("pass window_id");
    expect(f.calls.some((c) => c.argv[0] === "get_app_state")).toBe(false);
    const shot = await f.call("desktop_screenshot", { app: "TextEdit", window_id: "w-101" });
    const id = /screen_id (\S+):/.exec(f.said(shot))![1]!;
    expect(f.said(await f.call("desktop_pointer", { screen_id: id, action: "click", x: 10, y: 20 }))).toBe("Pointer click delivered");
    expect(f.calls.filter((c) => c.runtime === "geist").every((c) => c.args?.app === "pid:12")).toBe(true);
  });

  test("same snapshot IDs cannot overwrite another conversation's target guards", async () => {
    const f = fixture();
    await f.call("desktop_snapshot", { app: "TextEdit" });
    f.state.tree = tree("Save");
    await f.call("desktop_snapshot", { app: "TextEdit" }, "pi-other");
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e2" }))).toContain("desktop_propose");
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e2" }, "pi-other"))).toBe("Clicked");
    expect(f.calls.filter((c) => c.argv[0] === "click")).toHaveLength(1);
  });

  test("foreign or invalid input cannot consume a screen; settled calls replay after consumption", async () => {
    const f = fixture();
    const shot = await f.call("desktop_screenshot", { app: "TextEdit" });
    const id = /screen_id (\S+):/.exec(f.said(shot))![1]!;
    const args = { screen_id: id, action: "click", x: 10, y: 20 };
    expect(f.said(await f.call("desktop_pointer", args, "pi-other"))).toContain("used or expired");
    expect(f.said(await f.call("desktop_pointer", { ...args, to_x: 30 }))).toContain("Only drag");
    expect(f.said(await f.call("desktop_pointer", { ...args, x: 400 }))).toContain("outside the screenshot");
    expect(f.said(await f.call("desktop_pointer", args, "pi-desktop", "pointer"))).toBe("Pointer click delivered");
    expect(f.said(await f.call("desktop_pointer", args))).toContain("used or expired");
    expect(f.said(await f.call("desktop_pointer", args, "pi-desktop", "pointer"))).toBe("Pointer click delivered");
    expect(f.said(await f.call("desktop_pointer", { ...args, x: 11 }, "pi-desktop", "pointer"))).toContain("different input");
    expect(f.calls.filter((c) => c.runtime === "geist" && c.argv[0] === "click")).toHaveLength(1);
    await f.call("desktop_snapshot", { app: "TextEdit" });
    const fresh = await f.call("desktop_screenshot", { app: "TextEdit" });
    expect(f.said(await f.call("desktop_click", { ref: "@sabc:e1" }))).toContain("fresh snapshot");
    await f.call("desktop_snapshot", { app: "TextEdit" });
    expect(f.said(await f.call("desktop_keys", { screen_id: /screen_id (\S+):/.exec(f.said(fresh))![1]!, key: "Tab" }))).toContain("used or expired");
  });

  test("focus and launch never bring inaccessible or other-Space windows forward", async () => {
    const f = fixture();
    f.state.windowVisible = false;
    expect(f.said(await f.call("desktop_focus", { app: "TextEdit", window_id: "w-100" }))).toContain("another Space");
    expect(f.said(await f.call("desktop_launch", { app: "TextEdit" }))).toContain("another Space");
    f.state.windowVisible = true; f.state.windowAccessible = false;
    expect(f.said(await f.call("desktop_focus", { app: "TextEdit", window_id: "w-100" }))).toContain("inaccessible");
    expect(f.said(await f.call("desktop_launch", { app: "TextEdit" }))).toContain("inaccessible");
    expect(f.calls.some((c) => c.argv[0] === "focus-window" || c.argv[0] === "launch")).toBe(false);
    f.state.windowAccessible = true;
    expect(f.said(await f.call("desktop_focus", { app: "TextEdit", window_id: "w-100" }))).toBe("Window focused");
  });

  test("physical input refuses an invisible window before capture and after a captured window changes Space", async () => {
    const f = fixture();
    f.state.windowVisible = false;
    expect(f.said(await f.call("desktop_screenshot", { app: "TextEdit", window_id: "w-100" }))).toContain("another Space");
    expect(f.calls.some((c) => c.runtime === "geist")).toBe(false);
    f.state.windowVisible = true;
    const capture = await f.call("desktop_screenshot", { app: "TextEdit", window_id: "w-100" });
    const screen_id = /screen_id (\S+):/.exec(f.said(capture))![1]!;
    f.state.windowVisible = false;
    expect(f.said(await f.call("desktop_pointer", { screen_id, action: "click", x: 10, y: 10 }))).toContain("another Space");
    expect(f.calls.some((c) => c.runtime === "geist" && c.argv[0] === "click")).toBe(false);
  });

  test("both keyboard paths refuse system shortcuts across aliases, token order and duplicate modifiers", async () => {
    const f = fixture();
    const shot = await f.call("desktop_screenshot", { app: "TextEdit" });
    const screen_id = /screen_id (\S+):/.exec(f.said(shot))![1]!;
    for (const keys of ["cmd+q", "shift+cmd+q", "cmd+alt+shift+q", "q+control+meta", "option+command+escape", "esc+alt+super", "cmd+shift+delete", "backspace+shift+meta", "CMD+CMD+Q"]) {
      expect((await f.call("desktop_press", { app: "TextEdit", keys })).isError).toBe(true);
      expect((await f.call("desktop_keys", { screen_id, key: keys })).isError).toBe(true);
    }
    expect(f.calls.some((c) => c.argv[0] === "press" || c.argv[0] === "press_key")).toBe(false);
    // Refused shortcuts must not consume the screen or block ordinary keyboard use.
    expect((await f.call("desktop_keys", { screen_id, key: "Tab" })).isError).not.toBe(true);
    expect((await f.call("desktop_press", { app: "TextEdit", keys: "cmd+s" })).isError).not.toBe(true);
    expect(f.calls.filter((c) => c.argv[0] === "press" || c.argv[0] === "press_key").map((c) => c.runtime === "geist" ? c.args?.key : c.argv[1])).toEqual(["Tab", "cmd+s"]);
  });

  test("a secure field without focus metadata blocks physical typing until a clean capture", async () => {
    const f = fixture();
    f.state.protectedScreen = true;
    const shot = await f.call("desktop_screenshot", { app: "TextEdit" });
    expect((await f.call("desktop_keys", { screen_id: /screen_id (\S+):/.exec(f.said(shot))![1]!, text: "Do not enter" })).isError).toBe(true);
    expect(f.calls.some((c) => c.argv[0] === "type_text")).toBe(false);
    f.state.protectedScreen = false;
    const clean = await f.call("desktop_screenshot", { app: "TextEdit" });
    expect((await f.call("desktop_keys", { screen_id: /screen_id (\S+):/.exec(f.said(clean))![1]!, text: "Draft" })).isError).not.toBe(true);
    expect(f.calls.filter((c) => c.argv[0] === "type_text")).toHaveLength(1);
  });

  test("a protected accessibility target blocks physical keys even when absent from the image tree", async () => {
    const f = fixture();
    f.state.tree.children[2] = { ...f.state.tree.children[2]!, role: "securetextfield", name: "Password" };
    await f.call("desktop_snapshot", { app: "TextEdit" });
    expect((await f.call("desktop_click", { ref: "@sabc:e3" })).isError).not.toBe(true);
    const shot = await f.call("desktop_screenshot", { app: "TextEdit" });
    expect((await f.call("desktop_keys", { screen_id: /screen_id (\S+):/.exec(f.said(shot))![1]!, key: "Tab" })).isError).toBe(true);
    expect(f.calls.some((c) => c.argv[0] === "press_key")).toBe(false);
  });

  test("protected values are not exposed or written, and text limits count UTF-8 bytes", async () => {
    const f = fixture();
    f.state.tree.children[2] = { ...f.state.tree.children[2]!, role: "securetextfield", name: "Password", value: "owner-secret" };
    const snapshot = f.said(await f.call("desktop_snapshot", { app: "TextEdit" }));
    expect(snapshot).toContain("[protected]");
    expect(snapshot).not.toContain("owner-secret");
    expect(f.said(await f.call("desktop_fill", { ref: "@sabc:e3", text: "not-a-password" }))).toContain("Protected");
    f.state.tree = tree();
    await f.call("desktop_snapshot", { app: "TextEdit" });
    expect(f.said(await f.call("desktop_type", { ref: "@sabc:e3", text: "한".repeat(4000) }))).toContain("10,000 bytes");
    expect(f.calls.some((c) => c.argv[0] === "set-value" || c.argv[0] === "type")).toBe(false);
  });

  test("config takes explicit absolute paths or turns PC control off", () => {
    const root = tempDir();
    const desktop = { control: "/a/Ghost Control.app", agentDesktop: "/a/agent-desktop", geist: "/a/geist" };
    writeFileSync(join(root, "config.json"), JSON.stringify({ desktop }));
    expect(loadConfig({}, root).desktop).toEqual(desktop);
    writeFileSync(join(root, "config.json"), JSON.stringify({ desktop: null }));
    expect(loadConfig({}, root).desktop).toBeNull();
    writeFileSync(join(root, "config.json"), JSON.stringify({ desktop: { ...desktop, geist: "relative/geist" } }));
    expect(() => loadConfig({}, root)).toThrow("absolute");
  });
});

const helperBuild = process.platform === "darwin" && process.arch === "arm64" && existsSync("/usr/bin/swiftc");

describe.skipIf(!helperBuild)("Ghost Control helper", () => {
  test("runs only its two runtimes, isolates their state and stops Geist with itself", async () => {
    const root = tempDir();
    const build = Bun.spawnSync([join(import.meta.dir, "../../ghost-control/build.sh"), root, "0.0.0-test"], { stderr: "pipe", env: { ...process.env, GHOST_CONTROL_BUNDLE_ID: "dev.projectoxi.ghost.control.test" } });
    expect(build.exitCode).toBe(0);
    const runtime = (name: string, body: string) => {
      const path = join(root, name);
      writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(root, `${name}.calls`))}\n${body}\n`);
      chmodSync(path, 0o700);
      return path;
    };
    const agentDesktop = runtime("agent-desktop", `
case "$1" in
  type) input=$(cat); printf '{"ok":true,"data":{"stdin":"%s","home":"%s","owner":"%s"}}' "$input" "$AGENT_DESKTOP_HOME" "$OWNER_SECRET";;
  hang) sleep 30;;
  leak) sleep 30 & printf '%s' "$!" > ${JSON.stringify(join(root, "descendant.pid"))}; exit 0;;
  *) printf '{"ok":false,"error":{"code":"STALE_REF","message":"gone","disposition":{"delivery":"not_delivered","retry":"safe"}}}';;
esac`);
    const geist = runtime("geist", `if [ "$1" = stop ]; then printf '{"status":"success"}'; exit 0; fi
printf '{"status":"error","data":null,"error":{"code":"RESULT_UNKNOWN","message":"maybe","uncertain":true}}'; exit 1`);
    const control = new GhostControl({ control: join(root, "Ghost Control.app"), agentDesktop, geist }, join(root, "state"));
    process.env.OWNER_SECRET = "owner-only";
    try {
      const typed = await control.agentDesktop(["type", "@s1:e1", "--stdin"], { stdin: "안녕" });
      expect(typed).toEqual({ ok: true, data: { stdin: "안녕", home: join(root, "state/agent-desktop"), owner: "" }, error: null, delivered: true });
      expect(await control.agentDesktop(["click", "@s1:e1"])).toMatchObject({ ok: false, delivered: false, error: { code: "STALE_REF" } });
      expect(await control.geist("click", { snapshot_id: "x" })).toMatchObject({ ok: false, delivered: true, error: { code: "RESULT_UNKNOWN" } });
      expect(await control.agentDesktop(["hang"], { timeoutMs: 300 })).toMatchObject({ ok: false, delivered: true, error: { code: "TIMEOUT" } });
      const started = performance.now();
      expect(await control.agentDesktop(["leak"], { timeoutMs: 300 })).toMatchObject({ ok: false, delivered: true, error: { code: "TIMEOUT" } });
      expect(performance.now() - started).toBeLessThan(3_000);
      expect((await control.status()).idleSeconds).toBeGreaterThanOrEqual(0);
      expect(readdirSync(join(root, "state/runtime")).filter((name) => name.startsWith("geist-"))).toHaveLength(1);
    } finally {
      delete process.env.OWNER_SECRET;
      await control.shutdown();
      const descendant = join(root, "descendant.pid");
      if (existsSync(descendant)) {
        try { process.kill(Number(readFileSync(descendant, "utf8")), "SIGTERM"); } catch { /* already exited */ }
      }
    }
    expect(readdirSync(join(root, "state/runtime"))).toEqual([]);
    expect(readFileSync(join(root, "geist.calls"), "utf8").trim().split("\n").at(-1)).toBe("stop --json");
  }, 60_000);
});
