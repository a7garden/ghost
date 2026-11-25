import { createExtensionRuntime, ExtensionRunner, ModelRegistry, type AgentSession, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CodingDialog, CodingDialogAnswer } from "@ghost/contract";
import { invalid, notFound } from "../core/errors.ts";
import { newId } from "../core/ids.ts";

type DialogInput = Omit<CodingDialog, "id" | "createdAt">;
type Open = { dialog: CodingDialog; finish(answer: CodingDialogAnswer): void };
type DialogOptions = Parameters<ExtensionUIContext["confirm"]>[2];

export class Dialogs {
  private readonly queue: Open[] = [];
  constructor(private readonly changed: (dialog: CodingDialog | null) => void, private readonly canAsk: () => boolean) {}

  ask(input: DialogInput, opts?: DialogOptions): Promise<CodingDialogAnswer> {
    if (!this.canAsk() || opts?.signal?.aborted) return Promise.resolve({ cancel: true });
    const dialog = { ...input, title: input.title.slice(0, 400), message: input.message?.slice(0, 4000), id: newId(), createdAt: Date.now() };
    const { promise, resolve } = Promise.withResolvers<CodingDialogAnswer>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => this.finish(entry, { cancel: true });
    const entry = { dialog, finish: (answer: CodingDialogAnswer) => {
      opts?.signal?.removeEventListener("abort", cancel);
      clearTimeout(timer);
      resolve(answer);
    } };
    if (opts?.timeout !== undefined) timer = setTimeout(cancel, opts.timeout);
    opts?.signal?.addEventListener("abort", cancel, { once: true });
    this.queue.push(entry);
    if (this.queue.length === 1) this.changed(dialog);
    return promise;
  }

  answer(id: string, answer: CodingDialogAnswer): void {
    const active = this.queue[0];
    if (!active || active.dialog.id !== id) throw notFound("coding dialog is no longer open");
    const { dialog } = active;
    if (!answer.cancel) {
      const valid = (() => {
        switch (dialog.kind) {
          case "approval": case "confirm": return answer.value === "yes" || answer.value === "no";
          case "input": return typeof answer.value === "string";
          case "select": return dialog.options?.some(option => option.label === answer.value);
          case "choices": return dialog.options?.some(option => option.id === answer.optionId) || (dialog.allowText && typeof answer.text === "string");
        }
      })();
      if (!valid) throw invalid("invalid answer for the coding dialog");
    }
    this.finish(active, answer.cancel ? { cancel: true } : answer);
  }

  cancel(): void {
    if (!this.queue.length) return;
    for (const entry of this.queue.splice(0)) entry.finish({ cancel: true });
    this.changed(null);
  }

  private finish(entry: Open, answer: CodingDialogAnswer): void {
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    entry.finish(answer);
    if (index === 0) this.changed(this.queue[0]?.dialog ?? null);
  }

  async bind(session: AgentSession, onError: (error: unknown) => void): Promise<void> {
    // Retain Pi's headless defaults. The selected SDK UI functions
    // are routed to the same owner dialog queue as the explicit choices and approval tools.
    const defaults = new ExtensionRunner([], createExtensionRuntime(), "", session.sessionManager, new ModelRegistry(session.modelRuntime)).getUIContext();
    await session.bindExtensions({ mode: "rpc", onError,
      uiContext: {
        ...defaults,
        select: async (title, labels, opts) => {
          const options = labels.slice(0, 12).map((label, index) => ({ id: String(index), label: label.slice(0, 200) }));
          const answer = await this.ask({ kind: "select", title, options }, opts);
          const selected = options.findIndex(option => option.label === answer.value);
          return selected < 0 ? undefined : labels[selected];
        },
        confirm: async (title, message, opts) => (await this.ask({ kind: "confirm", title, message }, opts)).value === "yes",
        input: async (title, placeholder, opts) => (await this.ask({ kind: "input", title, placeholder: placeholder?.slice(0, 200) }, opts)).value,
      },
    });
  }
}
