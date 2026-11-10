import { expect, test } from "bun:test";
import { parseInput } from "../src/api/browser.ts";

test("owner viewport input refuses oversized surfaces, fractional pixels and arbitrary CDP commands", () => {
  expect(() => parseInput({ type: "viewport", width: 4096, height: 4096 })).toThrow();
  expect(() => parseInput({ type: "viewport", width: 390.5, height: 640 })).toThrow();
  expect(() => parseInput({ type: "viewport", width: 390, height: 640, method: "Runtime.evaluate", params: { expression: "document.title" } })).toThrow();
});
