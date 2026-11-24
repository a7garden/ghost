import { expect, test } from "bun:test";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createCodingTools } from "../src/tools/coding.ts";
import { harness, hostTaskId } from "./support.ts";

test("coding tools require a Host task identity for reads and an owner-PC Work for writes", async () => {
  const f = harness();
  try {
    const ghost = f.core.createGhost({ name: "Builder", persona: "", hostExecution: true, tools: ["code_run", "code_agents"] });
    const work = f.core.works.createRoot({ ghostId: ghost.id, originConversationId: ghost.directConversationId, title: "Confined", brief: "No PC access", execution: { kind: "workspace" } });
    await f.core.idle();
    f.ledger.setPiConversationId(ghost.directConversationId, "pi-direct");
    const conversation = f.ledger.work(work.id).conversationId!;
    f.ledger.setPiConversationId(conversation, "pi-work");
    const tools = createCodingTools(f.core).tools!;
    const call = async (name: string, args: object, conversationId: string, withTask = true) => {
      const result = await tools.find(tool => tool.name === name)!.execute(args as never, {
        conversationId, ...(withTask ? { taskId: hostTaskId() } : {}), callId: crypto.randomUUID(), output: () => {}, diagnostic: () => {},
      } as unknown as ToolExecutionApi, {} as Context);
      return result.output?.[0]?.type === "text" ? result.output[0].text : "";
    };
    expect(await call("code_agents", {}, "pi-direct", false)).toContain("task identity");
    expect(await call("code_run", { repo: "/repo", task: "Fix it" }, "pi-work")).toContain("owner-PC Work");
    expect(await call("code_agents", {}, "pi-work")).toContain("owner-PC Work");
    expect(f.ledger.effectsForWork(work.id)).toEqual([]);
  } finally {
    f.core.stop();
    await f.core.idle();
    f.ledger.close();
  }
});
