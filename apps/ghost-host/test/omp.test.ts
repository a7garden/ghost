import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OmpInfo, parse } from "@ghost/contract";
import { startServer } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";
import { OmpInfoProvider } from "../src/integrations/omp.ts";
import { harness, tempDir } from "./support.ts";

test("omp offers its models and a directory's recent conversations, newest first, without reading whole conversations", () => {
  const dir = tempDir();
  const home = realpathSync(dir);
  const sessions = join(home, ".omp/agent/sessions");
  const projects = join(home, "Work/app");
  mkdirSync(projects, { recursive: true });
  const folder = join(sessions, "-Work-app");
  mkdirSync(folder, { recursive: true });
  const write = (name: string, id: string, title: string, at: number) => {
    const path = join(folder, name);
    writeFileSync(path, `${JSON.stringify({ type: "title", title, pad: " ".repeat(40) })}\n${JSON.stringify({ type: "session", id, cwd: projects })}\n${"x".repeat(2_000_000)}\n`);
    utimesSync(path, at / 1000, at / 1000);
  };
  write("a.jsonl", "01aaaaaa-0000-7000-8000-000000000001", "older", 1_000_000);
  write("b.jsonl", "01bbbbbb-0000-7000-8000-000000000002", "title>newer", 2_000_000);
  writeFileSync(join(folder, "broken.jsonl"), "not json\n");
  writeFileSync(join(folder, "notes.txt"), "x");
  const outside = join(sessions, "--private-tmp-elsewhere--");
  try {
    const provider = new OmpInfoProvider({ executable: null, home });
    expect(provider.sessionsDir(projects)).toBe(folder);
    expect(provider.sessionsDir("/private/tmp/elsewhere")).toBe(outside);
    return provider.info(projects).then((info) => {
      expect(info.sessions).toEqual([
        { id: "01bbbbbb-0000-7000-8000-000000000002", title: "newer", updatedAt: 2_000_000 },
        { id: "01aaaaaa-0000-7000-8000-000000000001", title: "older", updatedAt: 1_000_000 },
      ]);
      expect(info.models).toEqual([]);
      return provider.info(join(home, "Work/none")).then((none) => expect(none.sessions).toEqual([]));
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
});

test("omp's models come from omp itself, chat models only, and a broken omp is no models rather than an error", async () => {
  const dir = tempDir();
  const script = join(dir, "omp");
  writeFileSync(script, `#!/bin/sh
echo '{"models":[{"provider":"anthropic","kind":"chat","selector":"anthropic/claude-x","name":"Claude X","thinking":["low","high"]},{"provider":"voyage","kind":"embedding","selector":"voyage/e","name":"E"},{"provider":"openai","selector":"openai/gpt-y","thinking":null}]}'
`);
  chmodSync(script, 0o755);
  const bad = join(dir, "bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "omp"), "#!/bin/sh\necho nope; exit 3\n");
  chmodSync(join(bad, "omp"), 0o755);
  try {
    const info = await new OmpInfoProvider({ executable: script, home: dir }).info(dir);
    expect(info.models).toEqual([
      { selector: "anthropic/claude-x", name: "Claude X", provider: "anthropic", thinking: ["low", "high"] },
      { selector: "openai/gpt-y", name: "openai/gpt-y", provider: "openai", thinking: [] },
    ]);
    expect((await new OmpInfoProvider({ executable: join(bad, "omp"), home: dir }).info(dir)).models).toEqual([]);
    await expect(new OmpInfoProvider({ executable: null }).info("relative")).rejects.toMatchObject({ code: "invalid" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner omp launcher lookup remains available without setup routes", async () => {
  const h = harness();
  const root = tempDir();
  const server = startServer({ core: h.core, config: loadConfig({ GHOST_PORT: "0" }, root), ownerToken: "omp-owner", documents: null, skills: null, omp: new OmpInfoProvider({ executable: null, home: root }) });
  const send = (route: string, method = "GET", token = "omp-owner") => fetch(`http://127.0.0.1:${server.port}${route}`, { method, headers: { authorization: `Bearer ${token}` } });
  try {
    const route = `/api/coding/omp?cwd=${encodeURIComponent(root)}`;
    expect((await send(route, "GET", "wrong")).status).toBe(401);
    expect(parse(OmpInfo, await (await send(route)).json())).toEqual({ models: [], sessions: [] });
    expect((await send("/api/coding/omp?cwd=relative")).status).toBe(400);
    expect((await send("/api/coding")).status).toBe(404);
    expect((await send("/api/coding/integrations", "POST")).status).toBe(404);
  } finally {
    await server.stop();
    h.core.stop();
    await h.core.idle();
    h.ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
