import { basename } from "node:path";
import type { TerminalAgent } from "@ghost/contract";

type Process = { pid: number; parent: number; group: number; foreground: number; tty: string; name: string; args: string };
const PS = ["/bin/ps", "-axww", "-o", `pid=,ppid=,pgid=,tpgid=,tty=,${process.platform === "darwin" ? "ucomm" : "comm"}=,args=`];
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.*)$/;

export function agentName(command: string): TerminalAgent | null {
  const file = basename(command).replace(/\.[cm]?js$/, "");
  return file === "omp" || file === "claude" || file === "codex" || file === "pi" ? file : null;
}

function processAgent(row: Process): TerminalAgent | null {
  const named = agentName(row.name);
  if (named) return named;
  // ps reports the interpreter as the executable for a #! script. Only inspect its script
  // operand, never arbitrary args (e.g. cat omp or a shell running `-c '...omp...'`).
  if (!/^(?:sh|bash|zsh|dash|fish|node|bun|deno|python[\d.]*|ruby|perl)$/.test(row.name)) return null;
  const [, first, second] = row.args.split(/\s+/, 3);
  const script = (row.name === "bun" || row.name === "deno") && first === "run" ? second : first;
  return script && !script.startsWith("-") ? agentName(script) : null;
}

export class TerminalProcesses {
  private readonly rows = new Map<number, Process>();

  constructor(text: string) {
    for (const line of text.split("\n")) {
      const row = ROW.exec(line);
      if (!row) continue;
      const pid = Number(row[1]);
      this.rows.set(pid, { pid, parent: Number(row[2]), group: Number(row[3]), foreground: Number(row[4]), tty: row[5]!, name: row[6]!, args: row[7]! });
    }
  }

  static async sample(): Promise<TerminalProcesses | null> {
    const child = Bun.spawn(PS, { stdout: "pipe", stderr: "ignore", env: { LC_ALL: "C" } });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? new TerminalProcesses(text) : null;
  }

  static snapshot(): TerminalProcesses {
    return new TerminalProcesses(Bun.spawnSync(PS, { stderr: "ignore", env: { LC_ALL: "C" } }).stdout.toString());
  }

  tty(pid: number): string | undefined {
    const tty = this.rows.get(pid)?.tty;
    return tty && tty !== "??" && tty !== "?" && tty !== "-" ? tty : undefined;
  }

  foreground(pid: number): { pid: number; agent: TerminalAgent } | null {
    const terminal = this.rows.get(pid);
    if (!terminal || terminal.foreground < 1 || !this.tty(pid)) return null;
    const leader = this.rows.get(terminal.foreground);
    if (leader?.tty === terminal.tty) {
      const agent = processAgent(leader);
      if (agent) return { pid: leader.pid, agent };
    }
    for (const row of this.rows.values()) {
      if (row === leader || row.tty !== terminal.tty || row.group !== terminal.foreground) continue;
      const agent = processAgent(row);
      if (agent) return { pid: row.pid, agent };
    }
    return null;
  }

  contains(pid: number): boolean { return this.rows.has(pid); }

  /** Interactive shells give foreground and background jobs their own groups. Detached descendants may have no tty. */
  kill(pid: number, tty: string | undefined, leaderAlive: boolean): void {
    const groups = new Set<number>();
    const descendants = new Set([pid]);
    let count: number;
    do {
      count = descendants.size;
      for (const row of this.rows.values()) if (descendants.has(row.parent)) descendants.add(row.pid);
    } while (descendants.size !== count);
    for (const row of this.rows.values()) {
      if (row.group > 0 && row.group !== pid && (descendants.has(row.pid) || (tty !== undefined && row.tty === tty))) groups.add(row.group);
    }
    // Stop jobs first, then the session leader. SIGKILL also prevents an exiting shell from starting a new job.
    if (leaderAlive || [...this.rows.values()].some(row => row.pid !== pid && row.group === pid)) groups.add(pid);
    for (const group of groups) {
      try { process.kill(-group, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
}
