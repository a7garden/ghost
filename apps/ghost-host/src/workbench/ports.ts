import type { WorkbenchTerminalSpec } from "@ghost/contract";

/** Bind the durable pane's spec to a Host-local PTY. Closing a layout never closes a coding session. */
export interface WorkbenchTerminals {
  create(input: WorkbenchTerminalSpec & { cols: number; rows: number }): string;
  closeTerminal(id: string): Promise<void>;
}
