import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareObscuraFonts } from "../src/integrations/obscura.ts";
import { tempDir } from "./support.ts";

const source = "/System/Library/Fonts/AppleSDGothicNeo.ttc";
const fontTest = process.platform === "darwin" && existsSync(source) ? test : test.skip;
fontTest("Obscura caches only the Korean system font privately and reuses an unchanged source fingerprint", () => {
  const root = tempDir();
  const directory = prepareObscuraFonts(root), font = join(directory, "AppleSDGothicNeo.ttc");
  expect(directory).toBe(join(realpathSync(root), "browser", "fonts"));
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(readdirSync(directory).sort()).toEqual(["AppleSDGothicNeo.ttc", "source.json"]);
  const cached = lstatSync(font), original = lstatSync(source);
  expect(cached.size).toBe(original.size);
  expect(cached.mode & 0o777).toBe(0o600);
  const metadata = join(directory, "source.json");
  expect(lstatSync(metadata).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({ path: source, size: original.size, mtimeMs: original.mtimeMs });
  expect(prepareObscuraFonts(root)).toBe(directory);
  expect(lstatSync(font).ino).toBe(cached.ino);
  expect(lstatSync(font).mtimeMs).toBe(cached.mtimeMs);
  // A stale source fingerprint triggers a new private copy, not reuse of stale bytes.
  writeFileSync(metadata, JSON.stringify({ path: source, size: 0, mtimeMs: 0 }));
  prepareObscuraFonts(root);
  expect(lstatSync(font).ino).not.toBe(cached.ino);
  expect(lstatSync(font).size).toBe(original.size);
});

fontTest("Obscura refuses symlinked directories, symlinked/hardlinked cache files and broad permissions", () => {
  const root = tempDir(), outside = tempDir();
  symlinkSync(outside, join(root, "browser"));
  expect(() => prepareObscuraFonts(root)).toThrow("Unsafe Obscura font cache directory");
  expect(readdirSync(outside)).toEqual([]);
  const safeRoot = tempDir(), directory = prepareObscuraFonts(safeRoot), font = join(directory, "AppleSDGothicNeo.ttc");
  chmodSync(font, 0o644);
  expect(() => prepareObscuraFonts(safeRoot)).toThrow("Unsafe Obscura font cache file");
  chmodSync(font, 0o600);
  unlinkSync(font); symlinkSync(source, font);
  expect(() => prepareObscuraFonts(safeRoot)).toThrow("Unsafe Obscura font cache file");
  unlinkSync(font); prepareObscuraFonts(safeRoot);
  const hardlink = join(tempDir(), "font-link"); linkSync(font, hardlink);
  expect(() => prepareObscuraFonts(safeRoot)).toThrow("Unsafe Obscura font cache file");
  unlinkSync(hardlink);
  const fingerprint = join(directory, "source.json");
  unlinkSync(fingerprint); symlinkSync(source, fingerprint);
  expect(() => prepareObscuraFonts(safeRoot)).toThrow("Unsafe Obscura font cache file");
  const nestedRoot = tempDir(); mkdirSync(join(nestedRoot, "browser"), { mode: 0o700 });
  symlinkSync(outside, join(nestedRoot, "browser", "fonts"));
  expect(() => prepareObscuraFonts(nestedRoot)).toThrow("Unsafe Obscura font cache directory");
});

fontTest("Obscura never grants a cache containing unrelated entries to the engine", () => {
  const root = tempDir(), directory = prepareObscuraFonts(root);
  writeFileSync(join(directory, "unrelated-owner-file"), "private", { mode: 0o600 });
  expect(() => prepareObscuraFonts(root)).toThrow("Unexpected Obscura font cache entry");
});
