import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGhostRuntime } from "../src/runtime.js";
import { createBrokerModelProvider, createLocalModelProvider } from "../src/models.js";
import { createModels } from "@earendil-works/pi-ai";
import { payloadDigest } from "../src/contract.js";
import { openGhostIndex } from "../src/storage.js";

const ghost = "ghost-direct-fixture", conversation = "conversation-direct-fixture";
const assignment = { id: "assignment-direct", source_command_id: "source-direct", ghost_id: ghost, conversation_id: conversation,
  goal_id: "goal-direct", goal_revision: 1, work_id: "work-direct", prompt: "Read input, edit, write, validate and publish output.", privacy: "public", origin_kind: "owner_goal", parent_work_id: null, root_goal_id: "goal-direct" };
function completion(request, message) {
  return { id: request.id, status: 200, body: { id: `completion-${request.id}`, object: "chat.completion", model: "minimax-code/MiniMax-M2.7", created: 1,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] } };
}
function envelope() {
  const body = { method: "conversation.assignment", ghost_id: ghost, conversation_id: conversation, goal_id: assignment.goal_id, goal_revision: 1, work_id: assignment.work_id, prompt: assignment.prompt, privacy: "public" };
  return { protocol_version: "ghost-lifetime/1", command_id: assignment.id, payload_digest: payloadDigest(body), actor_ref: ghost, authority_epoch: 1, expected_revision: null, correlation_id: assignment.id, body };
}
function hostFixture(binding = true, options = {}) {
  const calls = [], runs = new Map(), receipts = new Map();
  const transport = async input => {
    calls.push(input);
    switch (input.method) {
      case "inference.inspect": return { status: "success", data: { inference_scope: "public", authority_epoch: 1 } };
      case "conversation.assignment.inspect": return { status: "success", data: { assignment, ...((typeof binding === "function" ? binding() : binding) ? { execution: { engine: "pi", version: 1, ...(options.tools ? { tools: options.tools } : {}) } } : {}), skills: typeof options.skills === "function" ? options.skills() : options.skills ?? [],
        ...(options.workContext ? { execution_context: { kind: "ghost-work-context/1", ref: `wc-${"a".repeat(64)}`, assignment_id: assignment.id, work_id: assignment.work_id, goal_revision: 1, owner_revision: 1, authority_epoch: 1 } } : {}) } };
      case "work.context.claim": return { status: "success", data: { context_ref: input.context_ref } };
      case "conversation.turn.inspect": return { status: "success", data: { run: runs.get(input.turn_id) ?? { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: "queued", cancel_requested: false, cancel_command_id: null, submission_id: null, entry_id: null, reason_code: null, latest_status_command_id: null, created_at_ms: 1, updated_at_ms: 1 } } };
      case "conversation.turn_status": {
        const run = { turn_id: input.turn_id, ghost_id: ghost, conversation_id: conversation, state: input.arguments.status, cancel_requested: false, cancel_command_id: null, submission_id: input.arguments.submission_id, entry_id: input.arguments.entry_id, reason_code: input.arguments.reason_code, latest_status_command_id: input.invocation_id, created_at_ms: 1, updated_at_ms: 2 };
        runs.set(input.turn_id, run); return { status: "success", data: { run } };
      }
      case "work.execute": {
        assert.equal(input.input_digest, payloadDigest({ operation: input.operation, arguments: input.arguments }));
        assert.equal(input.assignment_id, assignment.id); assert.equal(input.work_id, assignment.work_id);
        assert.equal(input.ghost_id, ghost); assert.equal(input.conversation_id, conversation);
        const receipt = { assignment_id: input.assignment_id, work_id: input.work_id, generation_task_id: input.generation_task_id,
          task_id: input.task_id, call_id: input.call_id, input_digest: input.input_digest, execution_id: "pi-direct-fixture", state: "complete" };
        if (options.onExecute) return options.onExecute(input, receipt);
        assert.equal(receipts.has(input.invocation_id), false);
        receipts.set(input.invocation_id, receipt);
        return { status: "success", summary: `Fixture ${input.operation} receipt`, artifacts: [], next_actions: [], data: { receipt } };
      }
      case "work.execution.complete": return { status: "success", data: { assignment_id: input.assignment_id, work_id: input.work_id, task_id: input.task_id, execution_id: "pi-direct-fixture", accepted: false } };
      default: throw new Error(`Unexpected fixture callback ${input.method}`);
    }
  };
  return { calls, receipts, transport };
}

test("same Ghost Pi Harness performs direct tool round-trips and reports completion without OMP or another agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-direct-"));
  const host = hostFixture(); const requests = [];
  const steps = [["read", { path: "input.txt" }], ["edit", { path: "input.txt", edits: [{ oldText: "before", newText: "after" }] }], ["write", { path: "result.txt", content: "result" }], ["bash", { command: "test -s result.txt", timeout: 5 }], ["publish_artifact", { path: "result.txt", privacy: "public" }]];
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request);
    const step = steps[requests.length - 1];
    const args = step?.[0] === "edit" ? { ...step[1], edits: JSON.stringify(step[1].edits) } : step?.[1];
    return completion(request, step ? { role: "assistant", content: null, tool_calls: [{ id: `direct-call-${requests.length}`, type: "function", function: { name: step[0], arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "Published output; Host verification remains pending." });
  } });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport, onDiagnostic: d => console.error('DIAG', JSON.stringify(d).slice(0,300)) });
    assert.equal((await runtime.handle(envelope())).status, "success");
    await runtime.waitForIdle(ghost, conversation);
    assert.deepEqual(host.calls.filter(x => x.method === "work.execute").map(x => x.operation), steps.map(x => x[0]));
    assert.deepEqual(host.calls.find(x => x.operation === "edit").arguments, steps[1][1], "Pi repairs stringified edits before sending the canonical Host request");
    assert.equal(host.calls.filter(x => x.method === "work.execution.complete").length, 1);
    assert.equal(host.calls.some(x => ["work.submit", "work.pi.admit"].includes(x.method)), false);
    const directCalls = host.calls.filter(x => x.method === "work.execute");
    assert.equal(new Set(directCalls.map(x => x.generation_task_id)).size, 1);
    assert.equal(new Set(directCalls.map(x => x.task_id)).size, 5);
    assert.equal(requests.length, 6);
    const names = requests[0].body.tools.map(x => x.function.name); console.error('WIRETOOLS', names.join(','));
    for (const name of steps.map(x => x[0])) assert.equal(names.includes(name), true);
    assert.equal(names.includes("work_submit"), false);
    assert.equal(names.some(name => name.startsWith("bot_")), false);
    assert.equal(names.some(name => name.startsWith("memory_")), false);
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "answered"); } finally { await index.close(); }
    await runtime.close(); runtime = null;
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    await runtime.waitForIdle(ghost, conversation);
    assert.equal(requests.length, 6, "reopen cannot generate or execute again");
    assert.equal(host.receipts.size, 5);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("assignment without a Host Pi environment binding exposes no execution tools or legacy submission", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-no-binding-")); const host = hostFixture(false); let request;
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async input => { request = input; return completion(input, { role: "assistant", content: "Blocked: no isolated Pi environment is available." }); } });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    assert.equal((await runtime.handle(envelope())).status, "success"); await runtime.waitForIdle(ghost, conversation);
    assert.equal(request.body.tools.some(x => ["read", "write", "edit", "bash", "publish_artifact", "work_submit"].includes(x.function.name)), false);
    assert.equal(host.calls.some(x => x.method === "work.execute" || x.method === "work.execution.complete"), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});


test("pinned skill bytes and explicitly granted browser stay inside the same Pi Work across reload and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-skills-browser-"));
  const oldContent = "OLD_PIN_PROCEDURE", nextContent = "NEW_ACTIVE_PROCEDURE";
  const pinned = [{ name: "research", sha256: createHash("sha256").update(oldContent).digest("hex"), privacy: "public", content: oldContent }];
  let activeContent = oldContent;
  const host = hostFixture(true, { skills: () => pinned, tools: ["read", "write", "edit", "bash", "publish_artifact", "browser"] });
  const requests = [];
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request);
    assert.equal(JSON.stringify(request.body.messages).includes(oldContent), true);
    assert.equal(JSON.stringify(request.body.messages).includes(nextContent), false);
    if (requests.length === 1) { activeContent = nextContent; return completion(request, { role: "assistant", content: null, tool_calls: [{ id: "isolated-browser-read", type: "function", function: { name: "browser", arguments: JSON.stringify({ operation: "snapshot" }) } }] }); }
    return completion(request, { role: "assistant", content: "Used the pinned skill and same Work browser; acceptance pending." });
  } });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    assert.equal((await runtime.handle(envelope())).status, "success"); await runtime.waitForIdle(ghost, conversation);
    assert.equal(activeContent, nextContent); assert.equal(host.calls.filter(x => x.method === "work.execute").length, 1);
    assert.equal(host.calls.find(x => x.method === "work.execute").operation, "browser");
    const index = await openGhostIndex(root, ghost);
    try { assert.deepEqual(JSON.parse((await index.get("SELECT manifest_json FROM ghost_assignment_skill_pins WHERE assignment_id = ?", assignment.id)).manifest_json), pinned); } finally { await index.close(); }
    await runtime.close(); runtime = null;
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport }); await runtime.waitForIdle(ghost, conversation);
    assert.equal(requests.length, 2); assert.equal(host.calls.filter(x => x.method === "work.execute").length, 1);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("changed Host skill pins block the next inference and remain blocked after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-skill-drift-"));
  const makeSkill = content => ({ name: "research", sha256: createHash("sha256").update(content).digest("hex"), privacy: "public", content });
  let skills = [makeSkill("old-byte-pin")]; const host = hostFixture(true, { skills: () => skills }); let requests = 0;
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests += 1; skills = [makeSkill("forbidden-new-byte-pin")];
    return completion(request, { role: "assistant", content: null, tool_calls: [{ id: "read-before-pin-drift", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "input.txt" }) } }] });
  } });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    assert.equal((await runtime.handle(envelope())).status, "success"); await runtime.waitForIdle(ghost, conversation);
    assert.equal(requests, 1);
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "effect_unknown"); } finally { await index.close(); }
    await runtime.close(); runtime = null;
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport }); await runtime.waitForIdle(ghost, conversation);
    assert.equal(requests, 1);
    assert.equal(host.calls.some(x => x.method === "work.execution.complete"), false);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});


test("withdrawn execution capability after lost ACK cannot hide a durable unknown effect as an answered turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-withdrawn-")); let withdrawn = false;
  const host = hostFixture(() => !withdrawn); let requests = 0;
  const transport = input => { if (input.method === "work.execute") { withdrawn = true; throw new Error("ACK lost after effect"); } return host.transport(input); };
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests += 1;
    return completion(request, requests === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "unknown-before-withdrawal", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "append-effect" }) } }] } : { role: "assistant", content: "The effect is unresolved and direct execution was withdrawn." });
  } });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: transport });
    assert.equal((await runtime.handle(envelope())).status, "success"); await runtime.waitForIdle(ghost, conversation);
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "effect_unknown"); } finally { await index.close(); }
    assert.equal(host.calls.some(x => x.method === "work.execution.complete"), false);
    assert.equal(requests, 2);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("an assignment that only coordinates does not fabricate a producer completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-pi-coordination-")); const host = hostFixture(true);
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => completion(request, { role: "assistant", content: "Waiting for the delegated child; no execution result is claimed." }) });
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    assert.equal((await runtime.handle(envelope())).status, "success"); await runtime.waitForIdle(ghost, conversation);
    assert.equal(host.calls.some(x => x.method === "work.execute" || x.method === "work.execution.complete"), false);
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "answered"); } finally { await index.close(); }
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});


test("browser Owner approval waits in one durable child and resumes the exact call without another model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-browser-owner-wait-")); let count = 0; const invocations = [], requests = [];
  const host = hostFixture(true, { tools: ["browser"], onExecute: (input, receipt) => {
    invocations.push(input); count += 1;
    return count < 3 ? { status: "warning", data: { action_id: "exact-owner-action", receipt: { ...receipt, state: "waiting_owner" } } }
      : { status: "success", data: { receipt } };
  } });
  const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
    requests.push(request); return completion(request, requests.length === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "original-browser-call", type: "function", function: { name: "browser", arguments: JSON.stringify({ operation: "click", ref: "element-1", snapshot_id: 1 }) } }] }
      : { role: "assistant", content: "The exact Owner-approved browser action completed; Host acceptance remains separate." });
  } }); let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    await runtime.handle(envelope()); await runtime.waitForIdle(ghost, conversation);
    assert.equal(count, 3); assert.equal(requests.length, 2); assert.deepEqual(invocations[0], invocations[1]); assert.deepEqual(invocations[1], invocations[2]);
    assert.equal(host.calls.filter(input => input.method === "work.execution.complete").length, 1);
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a browser approval wait reopens the same child and call; unknown and denied receipts cannot execute replacement effects", async () => {
  for (const finalState of ["complete", "denied", "unknown"]) {
    const root = await mkdtemp(join(tmpdir(), "ghost-browser-owner-reopen-")); const invocations = [], requests = []; let ready, resumed = false;
    const waiting = new Promise(resolve => { ready = resolve; });
    const host = hostFixture(true, { tools: ["browser"], onExecute: (input, receipt) => {
      invocations.push(input);
      if (!resumed) { if (invocations.length >= 2) ready(); return { status: "warning", data: { action_id: "restart-owner-action", receipt: { ...receipt, state: "waiting_owner" } } }; }
      return { status: finalState === "complete" ? "success" : "error", ...(finalState === "unknown" ? { error_code: "pi_effect_unknown" } : {}), data: { receipt: { ...receipt, state: finalState } } };
    } });
    const provider = createBrokerModelProvider({ modelRef: "minimax-code/MiniMax-M2.7", invoke: async request => {
      requests.push(request); return completion(request, requests.length === 1 ? { role: "assistant", content: null, tool_calls: [{ id: "same-browser-call", type: "function", function: { name: "browser", arguments: JSON.stringify({ operation: "key", ref: "element-1", snapshot_id: 1, value: "Enter" }) } }] }
        : { role: "assistant", content: "Original browser receipt reconciled." });
    } }); let runtime;
    try {
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport }); await runtime.handle(envelope()); await waiting;
      assert.equal(requests.length, 1, "waiting cannot invoke a model");
      await runtime.close(); runtime = null; resumed = true;
      runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport }); await runtime.handle(envelope()); await runtime.waitForIdle(ghost, conversation);
      assert.ok(invocations.length >= 3); for (const input of invocations) assert.deepEqual(input, invocations[0]);
      assert.equal(host.calls.filter(input => input.method === "work.execution.complete").length, finalState === "complete" ? 1 : 0);
      const index = await openGhostIndex(root, ghost);
      try { const status = (await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status; assert.equal(status, finalState === "unknown" ? "effect_unknown" : "answered"); } finally { await index.close(); }
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  }
});

test("Work wait parks the original generation after an effect, survives reopen and resumes without replaying that effect", async () => {
  const { callbackCommandId } = await import("../src/host-transport.js");
  const { workWaitBody } = await import("../src/work-wait.js");
  const root=await mkdtemp(join(tmpdir(),"ghost-work-wait-reopen-"));
  const host=hostFixture(); let receipt=null, phase="waiting", waitingObserved, lostAck=true;
  const parked=new Promise(resolve=>{waitingObserved=resolve;}); const requests=[],waitInvocations=[];
  const transport=async input=>{
    if(input.method==="conversation.assignment.inspect") {
      const response=await host.transport(input);
      if(receipt) response.data.work_wait={receipt,phase};
      return response;
    }
    if(input.method==="work.wait") {
      waitInvocations.push(input);
      receipt ??= {kind:"pi-work-wait/1",assignment_id:input.assignment_id,work_id:input.work_id,goal_revision:1,owner_revision:1,
        generation_task_id:input.generation_task_id,authority_epoch:1,wait_command_id:callbackCommandId(ghost,conversation,input.invocation_id,"work.wait"),
        wait_payload_digest:payloadDigest(workWaitBody(input)),wait_for:input.arguments.wait_for,execution_id:"pi-direct-fixture"};
      if(lostAck){lostAck=false;throw Error("wait ACK lost after commit");}
      return {status:"success",summary:"Exact wait committed",artifacts:[],next_actions:[],data:{wait_receipt:receipt}};
    }
    if(input.method==="work.wait.inspect") {
      waitingObserved();
      return {status:"success",summary:"Exact wait inspected",artifacts:[],next_actions:[],data:{wait_receipt:receipt,phase}};
    }
    return host.transport(input);
  };
  const steps=[["write",{path:"answer.txt",content:"before"}],["work_wait",{work_id:assignment.work_id,wait_for:["child-work"]}],["edit",{path:"answer.txt",edits:[{oldText:"before",newText:"after"}]}]];
  const provider=createBrokerModelProvider({modelRef:"minimax-code/MiniMax-M2.7",invoke:async request=>{
    requests.push(request);const step=steps[requests.length-1];
    return completion(request,step?{role:"assistant",content:null,tool_calls:[{id:`wait-call-${requests.length}`,type:"function",function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{role:"assistant",content:"Continued the original Work after exact dependency release."});
  }});
  let runtime;
  try {
    runtime=await openGhostRuntime({root,mode:"broker",modelProvider:provider,hostToolTransport:transport});
    assert.equal((await runtime.handle(envelope())).status,"success");
    await Promise.race([parked,new Promise((_,reject)=>setTimeout(()=>reject(Error("wait did not park")),5000))]);
    assert.equal(requests.length,2);assert.equal(host.receipts.size,1);
    await runtime.close();runtime=null;
    runtime=await openGhostRuntime({root,mode:"broker",modelProvider:provider,hostToolTransport:transport});
    await runtime.handle(envelope());
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(requests.length,2,"parked reopen cannot infer before release");
    phase="resolved";
    await runtime.waitForIdle(ghost,conversation);
    assert.equal(requests.length,4);assert.deepEqual(host.calls.filter(x=>x.method==="work.execute").map(x=>x.operation),["write","edit"]);
    assert.equal(new Set(host.calls.filter(x=>x.method==="work.execute").map(x=>x.generation_task_id)).size,1);
    assert.equal(host.calls.filter(x=>x.method==="work.execution.complete").length,1);
    assert.ok(waitInvocations.length>=2);for(const input of waitInvocations) assert.deepEqual(input,waitInvocations[0]);
    const index=await openGhostIndex(root,ghost);try{assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?",assignment.id)).status,"answered");}finally{await index.close();}
  }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});

test("unverified Work wait receipt durably blocks inference and completion across reopen",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ghost-work-wait-unknown-"));const host=hostFixture();let count=0;
 const transport=input=>input.method==="work.wait"?Promise.resolve({status:"success",summary:"Unbound mock",artifacts:[],next_actions:[],data:{wait_receipt:{kind:"pi-work-wait/1"}}}):host.transport(input);
 const provider=createBrokerModelProvider({modelRef:"minimax-code/MiniMax-M2.7",invoke:async request=>{
  count++;return completion(request,{role:"assistant",content:null,tool_calls:[{id:`unknown-wait-${count}`,type:"function",function:{name:count===1?"write":"work_wait",arguments:JSON.stringify(count===1?{path:"before.txt",content:"original"}:{work_id:assignment.work_id,wait_for:["child"]})}}]});
 }});let runtime;
 try{runtime=await openGhostRuntime({root,mode:"broker",modelProvider:provider,hostToolTransport:transport});await runtime.handle(envelope());await runtime.waitForIdle(ghost,conversation);
 assert.equal(count,2);assert.equal(host.receipts.size,1);assert.equal(host.calls.some(input=>input.method==="work.execution.complete"),false);
 await runtime.close();runtime=null;runtime=await openGhostRuntime({root,mode:"broker",modelProvider:provider,hostToolTransport:transport});await runtime.waitForIdle(ghost,conversation);assert.equal(count,2);
 const index=await openGhostIndex(root,ghost);try{assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?",assignment.id)).status,"effect_unknown");}finally{await index.close();}
 }finally{await runtime?.close();await rm(root,{recursive:true,force:true});}
});

const text = message => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("") : "";

test("assignment conversations compact confirmed local histories before the output clamp and keep the exact Work prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-assignment-compaction-"));
  const host = hostFixture(); const calls = []; let ordinary = 0;
  const bulk = "assignment bulk payload ".repeat(180);
  const steps = [
    { tool: ["write", { path: "bulk-one.txt", content: bulk }] },
    { tool: ["write", { path: "bulk-two.txt", content: bulk }] },
    { tool: ["write", { path: "bulk-three.txt", content: bulk }] },
    { tool: ["bash", { command: "test -s bulk-three.txt", timeout: 5 }] },
  ];
  const local = createLocalModelProvider({ baseUrl: "http://127.0.0.1:19222/v1", modelId: "fixture/controlled-local", maxOutputTokens: 1024,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), summary = body.messages.some(message => text(message).includes("context summarization assistant"));
      calls.push({ body, summary }); if (!summary) ordinary++;
      const tokens = summary ? 2200 : 2600 + ordinary * 3000;
      const step = steps[ordinary - 1];
      const message = !summary && step ? { role: "assistant", content: null,
        tool_calls: [{ id: `bulk-${ordinary}`, type: "function", function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] }
        : { role: "assistant", content: "Assignment output written; Host verification remains pending." };
      return new Response(JSON.stringify({ id: `controlled-${calls.length}`, object: "chat.completion", created: 1, model: "fixture/controlled-local",
        choices: [{ index: 0, message, finish_reason: !summary && step ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: tokens, completion_tokens: 10, total_tokens: tokens + 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const provider = { ...local, forConversation(publicGuard, localGuard, resolveTools, onTools) {
    const models = createModels(); models.setProvider(local.forConversation(publicGuard, resolveTools, onTools));
    return { models, modelRef: local.modelRef, localModelRef: local.modelRef, localRouteConfig: local.localRouteConfig, streamOptions: local.streamOptions };
  } };
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    assert.equal((await runtime.handle(envelope())).status, "success");
    await runtime.waitForIdle(ghost, conversation);
    const summaryIndex = calls.findIndex(call => call.summary);
    assert.ok(summaryIndex > 0, "actual SDK must summarize the overflowing assignment history");
    assert.equal(calls[summaryIndex].body.tools?.length ?? 0, 0, "summary inference offers no effect tools");
    assert.equal(calls.at(-1).body.max_tokens, 1024, "the final request retains the captured output cap rather than a one-token remainder");
    assert.ok(calls.at(-1).body.messages.some(message => message.role === "user" && text(message).includes(assignment.prompt)),
      "the exact Work prompt remains after compaction");
    assert.deepEqual(host.calls.filter(x => x.method === "work.execute").map(x => x.operation), ["write", "write", "write", "bash"],
      "every scripted tool call executed exactly once");
    assert.ok(calls.at(-1).body.messages.length <= 6, "compacted request stays bounded");
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "answered"); } finally { await index.close(); }
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a long Work generation stays inside the local window: oldest rounds leave the wire before the output cap collapses", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-assignment-request-bound-"));
  const host = hostFixture(); const calls = []; let ordinary = 0;
  const bulk = "assignment bulk payload ".repeat(667);
  const steps = Array.from({ length: 9 }, (_, index) => ({ tool: ["write", { path: `bulk-${index}.txt`, content: bulk }] }));
  const local = createLocalModelProvider({ baseUrl: "http://127.0.0.1:19222/v1", modelId: "fixture/controlled-local", maxOutputTokens: 1024,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), summary = body.messages.some(message => text(message).includes("context summarization assistant"));
      calls.push({ body, summary }); if (!summary) ordinary++;
      const promptTokens = Math.ceil((init.body?.length ?? JSON.stringify(body).length) / 3.5);
      const step = steps[ordinary - 1];
      const message = !summary && step ? { role: "assistant", content: null,
        tool_calls: [{ id: `bulk-${ordinary}`, type: "function", function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] }
        : { role: "assistant", content: "All bulk writes finished; Host verification remains pending." };
      return new Response(JSON.stringify({ id: `controlled-${calls.length}`, object: "chat.completion", created: 1, model: "fixture/controlled-local",
        choices: [{ index: 0, message, finish_reason: !summary && step ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const provider = { ...local, forConversation(publicGuard, localGuard, resolveTools, onTools) {
    const models = createModels(); models.setProvider(local.forConversation(publicGuard, resolveTools, onTools));
    return { models, modelRef: local.modelRef, localModelRef: local.modelRef, localRouteConfig: local.localRouteConfig, streamOptions: local.streamOptions };
  } };
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    assert.equal((await runtime.handle(envelope())).status, "success");
    await runtime.waitForIdle(ghost, conversation);
    for (const [ci, call] of calls.entries()) { if (call.body.max_tokens !== 1024) console.error('CLAMPDBG', ci, call.summary?'SUM':'ord', 'msgs='+call.body.messages.length, 'bytes='+JSON.stringify(call.body.messages).length, 'maxtok='+call.body.max_tokens, 'roles='+call.body.messages.map(m=>m.role).join(',')); assert.equal(call.body.max_tokens, 1024, "no request may collapse to a one-token remainder"); }
    assert.deepEqual(host.calls.filter(x => x.method === "work.execute").map(x => x.operation), steps.map(x => x.tool[0]),
      "every scripted write executed exactly once");
    const last = calls.at(-1).body;
    assert.ok(last.messages.length < 2 + steps.length * 2, "the overflowing wire request was bounded to recent rounds");
    assert.ok(calls.some(call => JSON.stringify(call.body.messages).length < 2 * 1024 * steps.length),
      "at least one wire request provably omitted oldest rounds instead of carrying the full history");
    assert.ok(last.messages.some(message => message.role === "user" && text(message).includes(assignment.prompt)),
      "the exact Work prompt survives the bound");
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "answered"); } finally { await index.close(); }
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

test("work-context producer conversations compact and bound overflowing local histories like the controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-work-context-compaction-"));
  const host = hostFixture(true, { workContext: true }); const calls = []; let ordinary = 0;
  const bulk = "assignment bulk payload ".repeat(667);
  const steps = Array.from({ length: 9 }, (_, index) => ({ tool: ["write", { path: `bulk-${index}.txt`, content: bulk }] }));
  const local = createLocalModelProvider({ baseUrl: "http://127.0.0.1:19222/v1", modelId: "fixture/controlled-local", maxOutputTokens: 1024,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), summary = body.messages.some(message => text(message).includes("context summarization assistant"));
      calls.push({ body, summary }); if (!summary) ordinary++;
      const promptTokens = Math.ceil((init.body?.length ?? JSON.stringify(body).length) / 3.5);
      const step = steps[ordinary - 1];
      const message = !summary && step ? { role: "assistant", content: null,
        tool_calls: [{ id: `bulk-${ordinary}`, type: "function", function: { name: step.tool[0], arguments: JSON.stringify(step.tool[1]) } }] }
        : { role: "assistant", content: "All bulk writes finished; Host verification remains pending." };
      return new Response(JSON.stringify({ id: `controlled-${calls.length}`, object: "chat.completion", created: 1, model: "fixture/controlled-local",
        choices: [{ index: 0, message, finish_reason: !summary && step ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const provider = { ...local, forConversation(publicGuard, localGuard, resolveTools, onTools) {
    const models = createModels(); models.setProvider(local.forConversation(publicGuard, resolveTools, onTools));
    return { models, modelRef: local.modelRef, localModelRef: local.modelRef, localRouteConfig: local.localRouteConfig, streamOptions: local.streamOptions };
  } };
  let runtime;
  try {
    runtime = await openGhostRuntime({ root, mode: "broker", modelProvider: provider, hostToolTransport: host.transport });
    const ack = await runtime.handle(envelope());
    assert.equal(ack.status, "success", JSON.stringify(ack).slice(0, 300));
    assert.ok(ack.data.storage_ref.includes("/work-contexts/"), "the assignment must run in its sealed Work context store");
    await runtime.waitForIdle(ghost, conversation);
    for (const call of calls) assert.equal(call.body.max_tokens, 1024, "no request may collapse to a one-token remainder");
    assert.deepEqual(host.calls.filter(x => x.method === "work.execute").map(x => x.operation), steps.map(x => x.tool[0]),
      "every scripted write executed exactly once");
    assert.ok(calls.at(-1).body.messages.some(message => message.role === "user" && text(message).includes(assignment.prompt)),
      "the exact Work prompt survives in the Work context");
    assert.ok(calls.at(-1).body.messages.length < 2 + steps.length * 2, "the overflowing wire request was bounded to recent rounds");
    const index = await openGhostIndex(root, ghost);
    try { assert.equal((await index.get("SELECT status FROM ghost_canonical_turn_runs WHERE turn_id = ?", assignment.id)).status, "answered"); } finally { await index.close(); }
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});
