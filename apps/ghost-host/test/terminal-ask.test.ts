import { expect, test } from "bun:test";
import { detectTerminalAsk } from "../src/terminal/ask.ts";

const OMP_APPROVAL = `╭─ Allow tool: bash ──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Command: echo GHOST_CHAT_PROOF                                                                                      │
│  Approve                                                                                                           │
│   Approve bash for this session                                                                                     │
│   Deny                                                                                                              │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ↑/↓ choose · 󰌑 select · 󰘴 󰌑/󰘴 Q approve · 󱊷 deny · 󰘴 O details · type to deny and steer                             │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ⠇ 50s · 󰪟 Sonnet 5.5 ·  ghost-chat-proof.0BaJuY ·  main ?2 ·  0.5%/1M 󰁨 · 󰙺 0.00                    bash 실행 확인`;

// Reduced Claude Code and Codex terminal screens.
const CLAUDE_APPROVAL = ` Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2
  3 ## Overview
  4
  5 ## Tasks
  6
  7 ## Links
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No

 Esc to cancel · Tab to amend`;
const CODEX_APPROVAL = `  Implement this plan?

  1. Yes, implement this plan          Switch to Default and start coding.
  2. Yes, clear context and implement  Fresh thread. Context: 29% used.
› 3. No, stay in Plan mode             Continue planning with the model.

  Press enter to confirm or esc to go back`;

test("recognizes active approval and choice screens", () => {
  expect(detectTerminalAsk(OMP_APPROVAL, "omp")).toEqual({ title: "Allow tool: bash", detail: "Command: echo GHOST_CHAT_PROOF", choices: ["Approve", "Approve bash for this session", "Deny"] });
  expect(detectTerminalAsk(CLAUDE_APPROVAL, "claude")).toMatchObject({ title: "Do you want to create notes.md?", detail: "notes.md" });
  expect(detectTerminalAsk(CODEX_APPROVAL, "codex")?.choices[2]).toBe("No, stay in Plan mode");
  expect(detectTerminalAsk("Which path?\n  • Stream\n❯ • Batch\n↑/↓ to navigate · Enter to select", "omp")?.choices).toEqual(["Stream", "Batch"]);
  expect(detectTerminalAsk("$ run task\nContinue? [y/N]:", "omp")).toEqual({ title: "Continue?", detail: "$ run task", choices: ["Yes", "No"] });
});

test("ignores scrollback, free text and multi-choice prompts", () => {
  const menu = "Which target?\n❯ 1. Local\n  2. Staging";
  for (const text of [
    `${OMP_APPROVAL}\nContinuing on the next task`,
    `${menu}\nEsc to cancel · our next step is to run it`,
    `${menu}\nEnter to submit`,
    `${menu}\n  3. Type something.\nEnter to select`,
    `${menu}\n  3. Chat about this`,
    `${menu}\nTab/Arrow keys to navigate · Esc to cancel`,
    `Question 2 of 4\n${menu}`,
    `${menu}\nSpace to toggle · Enter to select`,
    "Which targets?\n❯ 1. [ ] Local\n  2. [x] Staging\nEnter to select",
    "Enter your answer:\n❯ \nEnter to submit",
    "Which target?\n1. Local\n2. Staging\nEnter to select",
    "Which target?\n❯ 1. Local\n❯ 2. Staging",
  ]) expect(detectTerminalAsk(text, "omp")).toBeNull();
});
