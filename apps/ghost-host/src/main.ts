#!/usr/bin/env bun
import { resolve } from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { openApp, serve } from "./app.ts";
import { backup } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { runImport } from "./import/index.ts";
import { runCredentialPluginCli } from "./integrations/browser-credential.ts";

const USAGE = `ghost — one process for every Ghost

  ghost serve                      run the host (state root: $GHOST_ROOT or ~/Library/Application Support/Ghost)
  ghost import --from <old-root> [--artifacts <worker-root>]...
                                   copy a pre-Bun state root into an empty state root
  ghost backup <dir>               consistent ledger.db + pi.db copies and backup.json, safe while serving
  ghost doctor                     check the state root and configuration
  ghost browser-credential --root <dir> --shade <cli>
                                   agent-browser credential plugin (started by agent-browser, not by hand)

  --root <dir>                     override the state root`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  // Started by agent-browser with its own environment; it reads only the grant file and Shade.
  if (command === "browser-credential") {
    process.exitCode = await runCredentialPluginCli(args);
    return;
  }
  const config = loadConfig(process.env, option(args, "--root"));

  switch (command) {
    case "serve":
      await serve(config);
      return;

    case "import": {
      const from = option(args, "--from");
      if (!from) throw new Error("ghost import needs --from <old-root>");
      if (resolve(from) === config.root) throw new Error("import into a different state root than the source");
      const app = await openApp(config);
      try {
        const artifactRoots = args.flatMap((arg, index) => (arg === "--artifacts" && args[index + 1] ? [resolve(args[index + 1]!)] : []));
        const report = await runImport({ from: resolve(from), artifactRoots, ledger: app.ledger, engine: app.engine, core: app.core, log: (line) => console.log(line) });
        console.log(JSON.stringify(report, null, 2));
      } finally {
        await app.close();
      }
      return;
    }

    case "backup": {
      const target = args.find((arg) => !arg.startsWith("--") && arg !== option(args, "--root"));
      if (!target) throw new Error("ghost backup needs a target directory");
      console.log(JSON.stringify(backup(config.root, resolve(target)), null, 2));
      return;
    }

    case "doctor": {
      const app = await openApp(config);
      try {
        const status = app.engine.status();
        const ghosts = app.ledger.ghosts();
        console.log(JSON.stringify({ root: config.root, port: config.port, sandbox: config.sandbox.kind, memory: config.memory !== null, ghosts: ghosts.length, engine: status }, null, 2));
        if (!status.ready) process.exitCode = 1;
      } finally {
        await app.close();
      }
      return;
    }

    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 2;
  }
}

// pi-ai's default OAuth loader uses runtime paths, which do not exist inside a standalone binary.
registerBunOAuthFlows();

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
