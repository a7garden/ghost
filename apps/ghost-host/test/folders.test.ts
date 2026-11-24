import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFolders } from "../src/api/folders.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "folders-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));
for (const dir of ["Workspace/Projects/app/.git", "Workspace/Projects/notes", ".ssh", ".hidden", "state"]) mkdirSync(join(home, dir), { recursive: true });
writeFileSync(join(home, "file.txt"), "x");
symlinkSync(join(home, ".ssh"), join(home, "Workspace/ssh-link"));
const options = { home, stateRoot: join(home, "state") };

test("lists only folders, marks git checkouts and hides dot folders", () => {
  const listing = listFolders(join(home, "Workspace/Projects"), options);
  expect(listing.entries.map((entry) => [entry.name, entry.git])).toEqual([["app", true], ["notes", false]]);
  expect(listing.parent).toBe(join(home, "Workspace"));
  const root = listFolders(null, options);
  expect(root.path).toBe(home);
  expect(root.entries.map((entry) => entry.name)).toEqual(["Workspace"]);
  expect(listFolders(null, { ...options, hidden: true }).entries.map((entry) => entry.name)).toEqual([".hidden", "Workspace"]);
});

test("credential folders and the state root stay out, even through a symlink", () => {
  expect(listFolders(join(home, "Workspace"), options).entries.map((entry) => entry.name)).toEqual(["Projects"]);
  expect(() => listFolders(join(home, ".ssh"), options)).toThrow();
  expect(() => listFolders(join(home, "Workspace/ssh-link"), options)).toThrow();
  expect(() => listFolders(join(home, "state"), options)).toThrow();
});

test("refuses relative paths, files and missing folders; expands ~", () => {
  expect(() => listFolders("Workspace", options)).toThrow();
  expect(() => listFolders(join(home, "file.txt"), options)).toThrow();
  expect(() => listFolders(join(home, "nope"), options)).toThrow();
  expect(listFolders("~/Workspace", options).path).toBe(join(home, "Workspace"));
});

test("shortcuts start from home and the folders already in use", () => {
  const listing = listFolders(null, { ...options, known: [join(home, "Workspace/Projects/app"), join(home, "missing")] });
  expect(listing.shortcuts.map((entry) => entry.label)).toEqual(["홈", "Projects", "Workspace", "app"]);
});
