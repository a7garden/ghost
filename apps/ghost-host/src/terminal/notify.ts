import { basename } from "node:path";
import type { TerminalAgentEvent, TerminalView } from "@ghost/contract";
import type { Core } from "../core/core.ts";
import { codingPrefs } from "../integrations/herdr.ts";

/** Passive inbox and push, just like herdr notifications. Never wakes Ghost. */
export function terminalNotifier(core: Core): (terminal: TerminalView, event: TerminalAgentEvent) => void {
  let sequence = 0;
  return (terminal, event) => {
    const { ledger } = core;
    const { notify } = codingPrefs(ledger.setting<unknown>("coding", null));
    if (notify === "off" || (notify === "blocked" && event.type !== "waiting")) return;
    ledger.tx(() => {
      const ghost = ledger.defaultGhost();
      if (!ghost) return;
      core.notify({
        id: `coding:terminal:${terminal.id}:${++sequence}`,
        kind: "message",
        ghostId: ghost.id,
        conversationId: ghost.directConversationId,
        workId: null,
        decisionId: null,
        title: event.type === "waiting" ? "에이전트가 답을 기다려요"
          : event.reason === "exit" ? "에이전트가 종료됐어요" : "에이전트가 끝났어요",
        body: `${event.agent} · ${basename(terminal.cwd)}`.slice(0, 400),
      });
    });
  };
}
