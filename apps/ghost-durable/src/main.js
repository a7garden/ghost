import { createHostToolTransport } from "./host-transport.js";
import { createFixtureModelProvider, createLocalModelProvider, localOutputTokenLimit } from "./models.js";
import { errorResponse, protocolHandshake } from "./contract.js";
import { openGhostRuntime } from "./runtime.js";
import { createRegisteredModelProvider } from "./registered-models.js";
import { handleOrchestraReview } from "./orchestra-review.js";
import { isAbsolute } from "node:path";

const MAX_FRAME_BYTES = 1_048_576;

function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--root" && flag !== "--mode") throw new Error(`Unsupported startup flag: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (parsed.has(flag)) throw new Error(`Duplicate startup flag: ${flag}`);
    parsed.set(flag, value);
    index += 1;
  }
  const root = parsed.get("--root");
  const mode = parsed.get("--mode");
  if (!root || !["fixture", "broker", "orchestra-review"].includes(mode)) {
    throw new Error("Usage: node src/main.js --root PATH --mode fixture|broker|orchestra-review");
  }
  return { root, mode };
}

function writeFrame(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required by the configured Pi runtime.`);
  return value;
}
function optionalLocalModelProvider() {
  const baseUrl = process.env.GHOST_LIFETIME_LOCAL_MODEL_URL;
  const modelId = process.env.GHOST_LIFETIME_LOCAL_MODEL_ID;
  const rawOutputTokens = process.env.GHOST_LIFETIME_LOCAL_MAX_OUTPUT_TOKENS;
  if (rawOutputTokens !== undefined && !/^[1-9][0-9]*$/u.test(rawOutputTokens)) {
    throw new Error('Invalid explicit local output token limit.');
  }
  const maxOutputTokens = localOutputTokenLimit(rawOutputTokens === undefined ? undefined : Number(rawOutputTokens));
  if (rawOutputTokens !== undefined && (typeof baseUrl !== "string" || baseUrl.length === 0 || typeof modelId !== "string" || modelId.length === 0)) {
    throw new Error('An explicit local output limit requires the configured local route.');
  }
  if (baseUrl === undefined && modelId === undefined) return undefined;
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || typeof modelId !== "string" || modelId.length === 0) {
    return undefined;
  }
  try {
    const provider = createLocalModelProvider({ baseUrl, modelId, maxOutputTokens,
      // Emit only controlled codes/status, never prompts, response bodies,
      // tool arguments, credentials or exception messages.
      onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
    });
    if (process.env.GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY !== undefined && process.env.GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY !== provider.localRouteConfig.identity) {
      throw new Error('Pinned local route configuration differs from the captured Host identity.');
    }
    return provider;
  } catch {
    if (rawOutputTokens !== undefined || process.env.GHOST_LIFETIME_LOCAL_ROUTE_IDENTITY !== undefined) throw new Error('Captured local route is invalid.');
    return undefined;
  }
}


function requiredAuthorityEpoch() {
  const raw = requiredEnv("GHOST_PI_AUTHORITY_EPOCH");
  if (!/^[1-9][0-9]*$/u.test(raw)) throw new Error("GHOST_PI_AUTHORITY_EPOCH must be a positive decimal epoch.");
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("GHOST_PI_AUTHORITY_EPOCH must fit a positive JavaScript safe integer.");
  }
  return epoch;
}

async function* boundedLines(input) {
  let chunks = [], size = 0;
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(start, end);
      if (size + segment.length > MAX_FRAME_BYTES) throw new Error("JSONL request frame exceeds the limit.");
      chunks.push(segment); size += segment.length;
      if (newline < 0) break;
      yield new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
      chunks = []; size = 0; start = newline + 1;
    }
  }
  if (size !== 0) throw new Error("JSONL input ended before its newline.");
}

async function runOrchestraReview() {
  const hostRoot = requiredEnv("GHOST_LIFETIME_HOST_ROOT");
  if (!isAbsolute(hostRoot)) throw new Error("The review credential root must be absolute.");
  const authorityEpoch = requiredAuthorityEpoch();
  const modelProvider = createRegisteredModelProvider({ hostRoot });
  writeFrame(protocolHandshake("orchestra-review"));
  for await (const line of boundedLines(process.stdin)) {
    let input;
    try {
      input = JSON.parse(line);
    } catch {
      writeFrame(errorResponse("invalid_json", "JSONL request frame is not valid JSON.", "never", { command_id: null }));
      return;
    }
    writeFrame(await handleOrchestraReview(input, { authorityEpoch, modelProvider }));
    return;
  }
}

async function main() {
  const { root, mode } = parseArgs(process.argv.slice(2));
  let runtime;

  let localRouteConfigured = false;
  try {
    if (mode === "orchestra-review") {
      await runOrchestraReview();
      return;
    }
    let modelProvider;
    if (mode === "fixture") {
      modelProvider = createFixtureModelProvider();
    } else {
      const localModelProvider = optionalLocalModelProvider();
      localRouteConfigured = localModelProvider !== undefined;
      modelProvider = createRegisteredModelProvider({ hostRoot: requiredEnv("GHOST_LIFETIME_HOST_ROOT"),
        executable: process.env.GHOST_CODEX_EXECUTABLE, localModelProvider,
        onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`) });
    }
    const hostToolTransport = process.env.GHOST_LIFETIME_HOST_ROOT === undefined ? undefined : createHostToolTransport({
      callbackToken: requiredEnv("GHOST_PI_CALLBACK_TOKEN"),
      localCallbackToken: localRouteConfigured ? process.env.GHOST_PI_LOCAL_CALLBACK_TOKEN || undefined : undefined,
      hostRoot: requiredEnv("GHOST_LIFETIME_HOST_ROOT"),
      authorityEpoch: requiredAuthorityEpoch(),
    });
    runtime = await openGhostRuntime({
      root, mode, modelProvider, hostToolTransport,
      onDiagnostic: (diagnostic) => process.stderr.write(`${JSON.stringify(diagnostic)}\n`),
    });
    // Only a configured runtime publishes readiness; diagnostics stay on stderr.
    writeFrame(protocolHandshake(mode));
    for await (const line of boundedLines(process.stdin)) {
      let input;
      try {
        input = JSON.parse(line);
      } catch {
        writeFrame(errorResponse("invalid_json", "JSONL request frame is not valid JSON.", "never"));
        continue;
      }
      writeFrame(await runtime.handle(input));
    }
  } catch (error) {
    process.stderr.write(`[ghost-durable] ${error?.name ?? "Error"}: runtime startup or request loop failed.\n`);
    process.exitCode = 1;
  } finally {
    if (runtime) {
      try {
        await runtime.close();
      } catch (error) {
        process.stderr.write(`[ghost-durable] ${error?.name ?? "Error"}: runtime close failed.\n`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[ghost-durable] ${error?.name ?? "Error"}: runtime entrypoint failed.\n`);
  process.exitCode = 1;
});
