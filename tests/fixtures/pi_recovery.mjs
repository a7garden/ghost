// Deterministic transport faults only. No model, tool, or external account.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const root = process.argv[process.argv.indexOf("--root") + 1];
const statePath = join(dirname(root), "pi-recovery.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath))
  : { starts: 0, assignment_ids: [], admissions: 0, receipt: null };
const save = () => writeFileSync(statePath, JSON.stringify(state));
state.starts += 1;
save();
if (state.starts === 1) process.exit(1);
if (state.starts === 2) {
  // A live child that never handshakes must not wedge the Host forever.
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ protocol_version: "ghost-lifetime/1", contract_revision: 1,
    mode: process.argv[process.argv.indexOf("--mode") + 1], runtime_identity: { durable: "@earendil-works/pi-durable@1.1.0" } }) + "\n");
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const command = JSON.parse(line);
    const body = command.body;
    let response = { status: "success", summary: "fixture durable receipt", object_refs: [], artifacts: [],
      next_actions: [], error_code: null, retry_class: "never", data: {
        command_id: command.command_id, ghost_id: body.ghost_id, conversation_id: body.conversation_id,
        runtime_kind: "pi-durable", runtime_release: "1.1.0", storage_ref: "fixture/original-storage",
      } };
    if (body.method === "conversation.assignment") {
      state.assignment_ids.push(command.command_id);
      if (state.assignment_ids.length === 1) {
        response = { ...response, status: "error", error_code: "goal_assignment_inspection_unconfirmed", retry_class: "same_id" };
      } else if (state.receipt === null) {
        state.admissions += 1;
        state.receipt = response;
        save();
        // Admission committed, but the Host loses the ACK. Reopen must recover
        // this exact receipt, with no second admission or replacement ID.
        process.exit(0);
      } else {
        if (command.command_id !== state.receipt.data.command_id) throw new Error("replacement command ID");
        response = state.receipt;
      }
      save();
    }
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
