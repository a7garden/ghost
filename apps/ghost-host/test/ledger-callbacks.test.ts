import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.ts";
import { tempDir } from "./support.ts";

const ghost = (id: string) => ({
  id, name: id, persona: "", look: { avatarId: null }, model: null, isDefault: false, state: "active" as const,
  tools: [], fallbacks: [], skills: [], deletedAt: null, directConversationId: `${id}-c`, createdAt: 1, updatedAt: 1,
});

describe("ledger post-commit callbacks", () => {
  test("a throwing listener neither fails the committed transaction nor starves later callbacks", () => {
    const ledger = new Ledger(join(tempDir(), "ledger.db"));
    const seen: string[] = [];
    let after = false;
    ledger.subscribe(() => { throw new Error("listener broke"); });
    ledger.subscribe((event) => seen.push(event.data.type));
    expect(() => ledger.tx(() => {
      ledger.afterCommit(() => { throw new Error("task broke"); });
      ledger.afterCommit(() => { after = true; });
      ledger.putGhost(ghost("g1"));
    })).not.toThrow();
    expect(ledger.ghost("g1").name).toBe("g1");
    expect(after).toBe(true);
    expect(seen).toEqual(["ghost"]);
    ledger.close();
  });
});
