import { join } from "node:path";
import {
  ORCHESTRATION_READ_TOOLS, ORCHESTRATION_TOOLS, SESSION_MODEL_ROLE, orchestrationIssues,
  type OrchestrationAgent, type OrchestrationImportPreview, type OrchestrationView,
} from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import { defaultOrchestration } from "./config.ts";
import { NAME, asMap, homePath, listFiles, parseYaml, readRegular, roleForModel, unknownKeys } from "./harness.ts";

/** Claude Code tool names with a Ghost orchestration equivalent; anything else stays unmappable. */
const TOOLS: Record<string, string> = {
  Read: "read", Grep: "grep", Glob: "find", LS: "ls",
  Edit: "edit", Write: "write", MultiEdit: "edit", NotebookEdit: "edit", Bash: "bash",
};
const WRITES: Record<string, true> = { edit: true, write: true, bash: true };

export function claudeSource(directory = homePath(".claude", "agents")): { available: boolean; agents: number } {
  const agents = listFiles(directory, ".md");
  return { available: agents.length > 0, agents: agents.length };
}

/** Read user-level ~/.claude/agents/*.md subagents; credentials live in other files and are never touched. */
export function previewClaude(inventory: Omit<OrchestrationView, "config">, directory = homePath(".claude", "agents")): OrchestrationImportPreview {
  const filenames = listFiles(directory, ".md");
  if (!filenames.length) throw invalid("Claude Code 에이전트를 찾을 수 없습니다");
  const config = defaultOrchestration();
  const unmappable: string[] = [];
  const imported = new Set<string>();
  for (const filename of filenames) {
    const path = `agents/${filename}`;
    try {
      const contents = readRegular(join(directory, filename), 48_000);
      const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(contents);
      if (!match) throw new Error();
      const fields = asMap(parseYaml(match[1]!, path));
      const { name, description, tools, model } = fields;
      const instructions = match[2]!.trim();
      if (typeof name !== "string" || !NAME.test(name) || imported.has(name) || typeof description !== "string" || description.length > 400 || instructions.length > 40_000) throw new Error();
      const existing = config.agents.findIndex(agent => agent.name === name);
      if (existing < 0 && config.agents.length >= 128) throw new Error();
      let allowed: OrchestrationAgent["tools"];
      if (tools === undefined) {
        // Claude Code defaults to every tool; Ghost cannot honor an implicit grant, so imported agents start read-only.
        allowed = [...ORCHESTRATION_READ_TOOLS];
        unmappable.push(`${path}.tools (기본 권한)`);
      } else {
        const listed = typeof tools === "string" ? tools.split(",").map(part => part.trim()).filter(Boolean)
          : Array.isArray(tools) && tools.every(tool => typeof tool === "string") ? tools as string[] : null;
        if (!listed) { allowed = [...ORCHESTRATION_READ_TOOLS]; unmappable.push(`${path}.tools`); }
        else {
          const mapped = [...new Set(listed.flatMap(tool => TOOLS[tool] ? [TOOLS[tool]!] : []))];
          const missing = listed.filter(tool => !TOOLS[tool]);
          if (missing.length) unmappable.push(`${path}.tools (${missing.join(", ")})`);
          allowed = ORCHESTRATION_TOOLS.filter(tool => mapped.includes(tool));
        }
      }
      const agent = { name, description, instructions, readOnly: !allowed.some(tool => WRITES[tool]), tools: allowed,
        modelRole: claudeModel(model, `${path}.model`), canDelegateTo: [] as string[] };
      if (existing >= 0) config.agents[existing] = agent;
      else config.agents.push(agent);
      imported.add(name);
      unmappable.push(...unknownKeys(fields, ["name", "description", "tools", "model"], `${path}.`));
    } catch { unmappable.push(path); }
  }
  return { config, unmappable, issues: orchestrationIssues(config, inventory) };

  function claudeModel(value: unknown, path: string): string {
    if (value === undefined) return SESSION_MODEL_ROLE;
    if (typeof value !== "string") { unmappable.push(path); return SESSION_MODEL_ROLE; }
    const alias = value.trim().toLowerCase();
    if (alias === "inherit") return SESSION_MODEL_ROLE;
    // Subscription aliases have no Ghost provider/model pair on this device.
    if (alias === "sonnet" || alias === "opus" || alias === "haiku") { unmappable.push(`${path} (${alias})`); return SESSION_MODEL_ROLE; }
    return roleForModel(config, inventory, value.trim(), undefined, path, unmappable);
  }
}
