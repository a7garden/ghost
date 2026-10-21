import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalModelProvider } from "../src/models.js";

const baseUrl = "http://127.0.0.1:8768/v1";
const modelId = "mlx-community/Qwen3.6-35B-A3B-4bit";

function toolRequest(names) {
  return {
    messages: [{ role: "user", content: "boundary probe", timestamp: 1 }],
    tools: names.map((name) => ({ name, parameters: { type: "object" } })),
  };
}

async function completeWithTools({ available, names, onMemoryToolsExposed }) {
  let forwarded;
  const provider = createLocalModelProvider({
    baseUrl,
    modelId,
    resolveMemoryTools: async () => available,
    onMemoryToolsExposed,
    fetchImpl: async (_url, options) => {
      forwarded = JSON.parse(options.body).tools?.map((tool) => tool.function?.name) ?? [];
      return new Response(JSON.stringify({
        id: "doc-test", object: "chat.completion", model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const model = provider.models.getModel("ghost-local", modelId);
  const result = await provider.models.complete(model, toolRequest(names), provider.streamOptions);
  return { forwarded, result };
}

test("empty capability receipts withhold document and memory tools from a local model request", async () => {
  const exposed = [];
  const { forwarded, result } = await completeWithTools({
    available: [],
    names: ["document_read_page", "document_list_spaces", "memory_search", "goal_inspect"],
    onMemoryToolsExposed: (_key, names) => exposed.push(...names),
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(forwarded, ["goal_inspect"]);
  assert.deepEqual(exposed, []);
});

test("document model tools are kept exactly when the current capability receipt grants their legacy names", async () => {
  const seen = new Map();
  const { forwarded, result } = await completeWithTools({
    available: ["read_page", "review_page"],
    names: ["document_read_page", "document_review_page", "document_list_spaces", "memory_search"],
    onMemoryToolsExposed: (key, names) => seen.set(key, names),
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(forwarded, ["document_read_page", "document_review_page"]);
  for (const names of seen.values()) {
    assert.deepEqual(names, ["document_read_page", "document_review_page"]);
  }
});

test("unknown or duplicate capability names are rejected before any model request", async () => {
  for (const available of [["read_page", "documents.list_pages"], ["read_page", "read_page"]]) {
    const { forwarded, result } = await completeWithTools({ available, names: ["document_read_page"] });
    assert.equal(forwarded, undefined);
    assert.equal(result.stopReason, "error");
    assert.equal(typeof result.errorMessage, "string");
  }
});
