#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { openApp, serve } from "./app.ts";
import { loadConfig } from "./config.ts";
import { runImport } from "./import/index.ts";

const USAGE = `ghost — one process for every Ghost

  ghost serve                      run the host (state root: $GHOST_ROOT or ~/Library/Application Support/Ghost)
  ghost import --from <old-root> [--artifacts <worker-root>]...
                                   copy a pre-Bun state root into an empty state root
  ghost backup <dir>               consistent copy of ledger.db and pi.db, safe while serving
  ghost doctor                     check the state root and configuration

  --root <dir>                     override the state root`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
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
      const dir = resolve(target);
      if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of ["ledger.db", "pi.db"]) {
        const source = join(config.root, name);
        if (!existsSync(source)) continue;
        const db = new Database(source, { readonly: true });
        db.exec(`VACUUM INTO '${join(dir, name).replaceAll("'", "''")}'`);
        db.close();
      }
      console.log(`backed up ledger.db and pi.db to ${dir}; copy artifacts/ and secrets/ with them`);
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

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
