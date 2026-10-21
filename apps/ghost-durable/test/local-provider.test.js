import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalModelProvider } from "../src/models.js";

const baseUrl = "http://127.0.0.1:8768/v1";
const modelId = "mlx-community/Qwen3.6-35B-A3B-4bit";

function responseFor({ model = modelId, content = "LOCAL_MODEL_REPLY", finishReason = "stop" } = {}) {
  return new Response(JSON.stringify({
    id: "local-test-completion",
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

async function completeWith(fetchImpl, onDiagnostic) {
  const provider = createLocalModelProvider({ baseUrl, modelId, fetchImpl, onDiagnostic });
  const model = provider.models.getModel("ghost-local", modelId);
  return provider.models.complete(model, {
    messages: [{ role: "user", content: "Local provider boundary probe.", timestamp: 1 }],
  }, provider.streamOptions);
}

test("local failures preserve their phase/status without logging private response bodies or retrying", async () => {
  for (const [fetchResponse, expected] of [
    [() => new Response('{"error":"PRIVATE_RESPONSE_SECRET"}', {
      status: 500, headers: { "content-type": "application/json" },
    }), { code: "local_inference_http_error", http_status: 500 }],
    [() => { throw new Error("PRIVATE_TRANSPORT_SECRET"); }, { code: "local_inference_transport_error" }],
    [() => responseFor({ finishReason: "length" }), { code: "local_inference_invalid_completion" }],
  ]) {
    const diagnostics = [];
    let calls = 0;
    const result = await completeWith(async () => { calls += 1; return fetchResponse(); },
      (diagnostic) => diagnostics.push(diagnostic));
    assert.equal(result.stopReason, "error");
    assert.equal(calls, 1);
    assert.equal(diagnostics.length, 1);
    for (const [key, value] of Object.entries(expected)) assert.equal(diagnostics[0][key], value);
    assert.equal(Number.isSafeInteger(diagnostics[0].at_ms), true);
    assert.match(diagnostics[0].request_id, /^[a-f0-9-]{36}$/u);
    if (expected.code === "local_inference_invalid_completion") {
      assert.equal(diagnostics[0].reason, "output_truncated");
      assert.equal(diagnostics[0].finish_reason, "length");
    }
    assert.equal(JSON.stringify(diagnostics).includes("PRIVATE_"), false);
  }
});

test("completion diagnostics distinguish safe reject reasons and correlate the trusted turn", async () => {
  const tool = { id: "call-1", type: "function", function: { name: "PRIVATE_UNKNOWN_TOOL", arguments: "{}" } };
  for (const [message, finish, reason] of [
    [{ role: "user", content: "PRIVATE_TEXT" }, "stop", "assistant_role"],
    [{ role: "assistant", content: "" }, "stop", "empty_content"],
    [{ role: "assistant", content: "PRIVATE_TEXT", tool_calls: [] }, "stop", "tool_calls_shape"],
    [{ role: "assistant", tool_calls: [tool] }, "tool_calls", "tool_not_exposed"],
  ]) {
    const diagnostics = [];
    const provider = createLocalModelProvider({ baseUrl, modelId,
      resolveDiagnosticContext: async () => ({ ghost_id: "ghost-1", conversation_id: "conversation-1", turn_id: "turn-1", command_id: "command-1", prompt: "PRIVATE_PROMPT" }),
      fetchImpl: async () => new Response(JSON.stringify({ model: modelId, choices: [{ message, finish_reason: finish }] }), { headers: { "content-type": "application/json" } }),
      onDiagnostic: (item) => diagnostics.push(item),
    });
    const result = await provider.models.complete(provider.models.getModel("ghost-local", modelId), {
      messages: [{ role: "user", content: "PRIVATE_INPUT", timestamp: 1 }],
    }, provider.streamOptions);
    assert.equal(result.stopReason, "error");
    assert.equal(diagnostics[0].reason, reason);
    assert.equal(diagnostics[0].turn_id, "turn-1");
    assert.equal(diagnostics[0].command_id, "command-1");
    assert.equal(JSON.stringify(diagnostics).includes("PRIVATE_"), false);
  }
});

test("local provider accepts one complete pinned loopback completion without auth headers", async () => {
  let observed;
  const result = await completeWith(async (url, options) => {
    observed = { url, options, body: JSON.parse(options.body) };
    return responseFor();
  });

  assert.equal(result.stopReason, "stop");
  assert.equal(result.content.some((part) => part.type === "text" && part.text === "LOCAL_MODEL_REPLY"), true);
  assert.equal(observed.url, `${baseUrl}/chat/completions`);
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.redirect, "error");
  assert.equal(observed.body.model, modelId);
  assert.equal(observed.body.stream, false);
  assert.equal(new Headers(observed.options.headers).has("authorization"), false);
});


test("local provider rejects remote, DNS, credentialed, or non-canonical endpoints before fetch", () => {
  for (const invalidUrl of [
    "https://model.example.test/v1",
    "http://127.0.0.1.nip.io:8768/v1",
    "http://user:pass@127.0.0.1:8768/v1",
    "http://127.0.0.1:8768/v1?model=private",
    "http://127.0.0.1:8768/v1/",
  ]) {
    assert.throws(() => createLocalModelProvider({ baseUrl: invalidUrl, modelId }));
  }
});

test("local provider rejects redirects, mismatched models, malformed, empty, and truncated completions", async () => {
  const invalidResponses = [
    () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8768/other" } }),
    () => responseFor({ model: "mlx-community/other-model" }),
    () => new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } }),
    () => responseFor({ content: "   " }),
    () => responseFor({ content: "partial reply", finishReason: "length" }),
  ];

  for (const makeResponse of invalidResponses) {
    const result = await completeWith(async () => makeResponse());
    assert.equal(result.stopReason, "error");
  }
});
