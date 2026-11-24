import { Terminal } from "@xterm/headless";
import type { TerminalAgent, TerminalAgentEvent, TerminalSize, TerminalState } from "@ghost/contract";
import { detectTerminalAsk } from "../integrations/herdr-ask.ts";

const PROMPT_QUIET_MS = 750;
const WORKING_ROW = /^(?:[\u2800-\u28ff✳✻✽✶✢·•○◐◓◑◒]\s+)?(?:working(?:[. …(]|$)|.*\([^)]*\b(?:esc to interrupt|esc to cancel)\b[^)]*\)\s*$)|^[\u2800-\u28ff]\s+(?:\d+[hms]\s*)+·\s*\p{Co}/iu;
const INPUT_ROW = /^(?:enter|type|provide) (?:your|an?) (?:answer|response|confirmation)(?:\b.*)?[:?]\s*$/i;

/** The last rendered screen, not an ANSI-stripped log: applications overwrite and clear earlier prompts. */
export class TerminalActivity {
  private readonly screen: Terminal;
  private lastOutput = -Infinity;
  private agentSince = -Infinity;
  private screenVersion = 0;
  private observedVersion = -1;
  private observedAgent: TerminalAgent | null = null;
  private seenScreen = "";
  private prompt: string | null = null;
  private ownWorking = false;
  private worked = false;
  private finished = false;
  private waiting: string | null = null;

  constructor(private readonly id: string, size: TerminalSize, private readonly quietMs: number, private readonly emit: (event: TerminalAgentEvent) => void) {
    this.screen = new Terminal({ ...size, allowProposedApi: true, scrollback: 0 });
  }

  output(bytes: Uint8Array, now: number): void {
    this.lastOutput = now;
    this.screen.write(bytes, () => { this.screenVersion++; });
  }

  resize({ cols, rows }: TerminalSize): void {
    this.screen.resize(cols, rows);
    this.screenVersion++;
  }

  resetAgent(now: number): void {
    this.agentSince = now;
    this.observedVersion = -1;
    this.observedAgent = null;
    this.seenScreen = "";
    this.prompt = null;
    this.ownWorking = false;
    this.worked = false;
    this.finished = false;
    this.waiting = null;
  }

  tick(agent: TerminalAgent | null, now: number, sampledAt: number): Exclude<TerminalState, "exited"> {
    // The shell can regain the foreground and print while ps is in flight.
    // Wait for a fresh snapshot before attributing those later bytes to the agent.
    if (this.lastOutput > sampledAt) return "working";
    const quiet = now - this.lastOutput;
    if (agent === null) return quiet < this.quietMs ? "working" : "idle";
    if (this.observedVersion !== this.screenVersion || this.observedAgent !== agent) {
      this.observedVersion = this.screenVersion;
      this.observedAgent = agent;
      const buffer = this.screen.buffer.active;
      const rows: string[] = [];
      for (let row = this.screen.rows - 1; row >= 0 && rows.length < 40; row--) {
        const line = buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "";
        if (line || rows.length) rows.push(line);
      }
      rows.reverse();
      const text = rows.join("\n");
      const ask = detectTerminalAsk(text, { id: this.id, agent })?.view;
      const last = rows.at(-1)?.trim();
      this.prompt = ask ? JSON.stringify([ask.title, ask.detail, ask.choices.map(choice => choice.label)])
        : last && INPUT_ROW.test(last) ? last : null;
      this.ownWorking = rows.slice(-8).some(line => WORKING_ROW.test(line.trim()));
      if (text !== this.seenScreen) {
        this.seenScreen = text;
        if (!this.prompt && (this.ownWorking || quiet < this.quietMs)) {
          this.waiting = null;
          this.finished = false;
          this.worked = true;
        }
      }
    }
    if (this.prompt && quiet >= PROMPT_QUIET_MS) {
      if (this.waiting !== this.prompt) {
        this.waiting = this.prompt;
        this.emit({ type: "waiting", agent, reason: "prompt" });
      }
      return "waiting";
    }
    if (this.ownWorking || quiet < this.quietMs || (this.worked && !this.finished && now - this.agentSince < this.quietMs)) {
      if (!this.finished) this.worked = true;
      return "working";
    }
    if (this.worked && !this.finished) {
      this.finished = true;
      this.emit({ type: "finished", agent, reason: "quiet" });
    }
    return "idle";
  }

  agentExited(agent: TerminalAgent): void {
    if (!this.finished) this.emit({ type: "finished", agent, reason: "exit" });
  }

  dispose(): void { this.screen.dispose(); }
}
