import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostToolTransport } from "../src/host-transport.js";

test("callback failures expose bounded stage/status without private response text", async () => {
  const root = await mkdtemp(join(tmpdir(), "ghost-callback-diagnostic-"));
  const owner = "a".repeat(64);
  let invalidJSON = false;
  const server = createServer((req, res) => {
    const nonce = req.url.split("/").at(-1);
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/api/v1/bootstrap/")) {
      res.end(JSON.stringify({ protocol: "ghost-control", version: 1,
        proof: createHmac("sha256", owner).update("ghost-control-bootstrap-v1\0").update(nonce).digest("hex") }));
    } else {
      res.statusCode = 403;
      res.end(invalidJSON ? "PRIVATE_RESPONSE_SECRET" : JSON.stringify({ ok: false, error: "PRIVATE_RESPONSE_SECRET" }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(join(root, ".ghost-control.json"), JSON.stringify({ protocol: "ghost-control", protocol_version: 1,
      host: "127.0.0.1", port: server.address().port, token: owner }), { mode: 0o600 });
    const transport = createHostToolTransport({ hostRoot: root, callbackToken: "public-callback", localCallbackToken: "private-callback", authorityEpoch: 1 });
    const input = { method: "conversation.assignment.inspect", invocation_id: "diagnostic-read", assignment_id: "assignment-1",
      ghost_id: "11111111-1111-7111-8111-111111111111", conversation_id: "22222222-2222-7222-8222-222222222222",
      inference_scope: "local", conversation_disclosure: "non_public", arguments: {} };
    for (const code of ["host_callback_rejected", "host_callback_invalid_receipt"]) {
      await assert.rejects(transport(input), error => {
        assert.equal(error.code, code); assert.equal(error.http_status, 403);
        assert.doesNotMatch(error.message, /PRIVATE_RESPONSE_SECRET/); return true;
      });
      invalidJSON = true;
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
