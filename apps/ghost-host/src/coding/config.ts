import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { CodingSession, PiContextUsage, PiSettings, PiSettingsOverrides } from "@ghost/contract";
import { invalid } from "../core/errors.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { CodingModels } from "./models.ts";

const defaults: PiSettings = {
  model: null, thinking: null,
  compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
  retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000 },
  steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  toolAllowlist: null, imageAutoResize: false,
};

// Pi's standalone loader looks for Photon next to the executable or in cwd.
// Do not turn it on when a compiled Host has no sidecar: Pi would omit the image.
const compiled = /\$bunfs|~BUN|%7EBUN/.test(import.meta.url);
const wasm = "photon_rs_bg.wasm";
const binaryDirectory = dirname(process.execPath);
const imageResizeAvailable = !compiled || [join(binaryDirectory, wasm), join(binaryDirectory, "photon", wasm), join(process.cwd(), wasm)]
  .some(path => statSync(path, { throwIfNoEntry: false })?.isFile());

function merge(base: PiSettings, overrides: PiSettingsOverrides): PiSettings {
  return { ...base, ...overrides, compaction: { ...base.compaction, ...overrides.compaction }, retry: { ...base.retry, ...overrides.retry } };
}

export function sdkPiSettings(config: PiSettings): NonNullable<Parameters<typeof SettingsManager.inMemory>[0]> {
  return { compaction: config.compaction, retry: config.retry, steeringMode: config.steeringMode,
    followUpMode: config.followUpMode, images: { autoResize: config.imageAutoResize }, cacheWarming: "off" };
}

export class PiConfig {
  constructor(private readonly ledger: Ledger, private readonly models: CodingModels) {}

  readonly imageResizeAvailable = imageResizeAvailable;

  defaults(): PiSettings {
    const config = merge(defaults, this.ledger.setting<PiSettingsOverrides>("pi.settings", {}));
    if (!this.imageResizeAvailable) config.imageAutoResize = false;
    return config;
  }

  overrides(id: string): PiSettingsOverrides {
    const config = this.ledger.setting<PiSettingsOverrides>(`pi.session.settings:${id}`, {});
    if (!this.imageResizeAvailable) delete config.imageAutoResize;
    return config;
  }
  effective(id: string): PiSettings { return merge(this.defaults(), this.overrides(id)); }

  preserveLegacySession(session: CodingSession): void {
    if (this.ledger.setting<PiSettingsOverrides | null>(`pi.session.settings:${session.id}`, null) === null) {
      this.saveOverrides(session.id, { model: session.model, thinking: session.thinking });
    }
  }

  context(id: string): PiContextUsage | null { return this.ledger.setting(`pi.session.context:${id}`, null); }

  saveContext(id: string, context?: PiContextUsage): void {
    if (context) this.ledger.putSetting(`pi.session.context:${id}`, context);
  }

  assertImageResize(enabled: boolean | undefined): void {
    if (enabled && !this.imageResizeAvailable) throw invalid("이 Host에서는 이미지를 자동 축소할 수 없습니다.");
  }

  async saveDefaults(settings: PiSettings): Promise<PiSettings> {
    this.assertImageResize(settings.imageAutoResize);
    // A null model delegates to the Host default, which may be unset during initial setup.
    if (settings.model) await this.models.use(settings.model, settings.thinking ?? undefined);
    this.ledger.putSetting("pi.settings", settings);
    return settings;
  }

  saveOverrides(id: string, overrides: PiSettingsOverrides): void {
    this.ledger.putSetting(`pi.session.settings:${id}`, overrides);
  }
  async selection(model?: PiSettings["model"], thinking?: PiSettings["thinking"], strict = false) {
    // An unsupported inherited level falls back to that model's default; an
    // explicit override is rejected by the same validation as session creation.
    if (strict) return this.models.use(model ?? undefined, thinking ?? undefined);
    const selected = await this.models.use(model ?? undefined);
    if (thinking && getSupportedThinkingLevels(selected.model).includes(thinking)) selected.thinking = thinking;
    return selected;
  }
}
