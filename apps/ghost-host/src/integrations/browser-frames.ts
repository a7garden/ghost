import { BrowserCdp } from "./browser-cdp.ts";
import type { BrowserLiveEvent } from "./ports.ts";

export interface ChromeViewportFrameRequest {
  targetId: string;
  viewport?: { width: number; height: number };
  maxFps: number;
}

export interface ChromeViewportFramesOptions {
  getCdpUrl: () => Promise<string>;
  isCurrent: () => boolean;
  onFrame: (frame: Extract<BrowserLiveEvent, { type: "frame" }>) => void;
  onError: () => void;
}

type Capture = ChromeViewportFrameRequest & { epoch: number };
type Attachment = { targetId: string; sessionId: string };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (typeof width !== "number" || typeof height !== "number" || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || width > 2560 || height < 1 || height > 1600) throw new Error("Invalid private viewport size");
  return { width, height };
}

function base64Digit(code: number): number {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return code === 43 ? 62 : 63;
}

// Read only JPEG marker bytes; decoding the entire pixel payload would allocate up to 8 MiB per frame.
function base64Byte(data: string, offset: number): number {
  const group = Math.floor(offset / 3) * 4, part = offset % 3;
  if (part === 0) return (base64Digit(data.charCodeAt(group)) << 2) | (base64Digit(data.charCodeAt(group + 1)) >> 4);
  if (part === 1) return ((base64Digit(data.charCodeAt(group + 1)) << 4) | (base64Digit(data.charCodeAt(group + 2)) >> 2)) & 0xff;
  return ((base64Digit(data.charCodeAt(group + 2)) << 6) | base64Digit(data.charCodeAt(group + 3))) & 0xff;
}

function base64Word(data: string, offset: number): number {
  return (base64Byte(data,offset) << 8) | base64Byte(data,offset + 1);
}

// Check the encoded pixels, not just the requested clip: mislabeled images break owner input mapping.
function validateJpeg(data: unknown, width: number, height: number): asserts data is string {
  if (typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Invalid private frame");
  const byteLength = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (byteLength > MAX_IMAGE_BYTES || byteLength < 4 || base64Word(data,0) !== 0xffd8) throw new Error("Invalid private frame");
  let offset = 2;
  while (offset < byteLength) {
    if (base64Byte(data,offset++) !== 0xff) break;
    while (offset < byteLength && base64Byte(data,offset) === 0xff) offset++;
    if (offset >= byteLength) break;
    const marker = base64Byte(data,offset++);
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > byteLength) break;
    const length = base64Word(data,offset);
    if (length < 2 || offset + length > byteLength) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length >= 8 && base64Word(data,offset + 3) === height && base64Word(data,offset + 5) === width) return;
      break;
    }
    offset += length;
  }
  throw new Error("Invalid private frame dimensions");
}

/** Damage-driven owner-only capture. No DOM evaluation, daemon pixels, disk, or model-visible transport. */
export class ChromeViewportFrames {
  private epoch = 0;
  private closed = false;
  private running = false;
  private desired?: Capture;
  private pending?: Capture;
  private timer?: NodeJS.Timeout;
  private lastStart = Number.NEGATIVE_INFINITY;
  private cdp?: BrowserCdp;
  private attachment?: Attachment;
  private stopDisconnect?: () => void;
  private stopEvents?: () => void;

  constructor(private readonly options: ChromeViewportFramesOptions) {}

  request(request: ChromeViewportFrameRequest): void {
    if (this.closed) return;
    const previous = this.desired;
    if (previous && (previous.targetId !== request.targetId || previous.viewport?.width !== request.viewport?.width || previous.viewport?.height !== request.viewport?.height)) this.invalidate();
    const capture: Capture = {
      targetId: request.targetId,
      ...(request.viewport ? { viewport: { ...request.viewport } } : {}),
      maxFps: Number.isFinite(request.maxFps) ? Math.min(15, Math.max(1, request.maxFps)) : 1,
      epoch: this.epoch,
    };
    this.desired = this.pending = capture;
    // Recompute a waiting deadline when active viewer FPS changes, without postponing the last start.
    clearTimeout(this.timer); this.timer = undefined;
    this.schedule();
  }

  invalidate(): void {
    this.epoch++;
    this.desired = this.pending = undefined;
    clearTimeout(this.timer); this.timer = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
    this.dropConnection();
  }

  private current(capture: Capture): boolean {
    return !this.closed && capture.epoch === this.epoch && this.options.isCurrent();
  }

  private schedule(): void {
    if (this.closed || this.running || this.timer || !this.pending) return;
    if (!this.current(this.pending)) { this.invalidate(); return; }
    const delay = 1000 / this.pending.maxFps - (performance.now() - this.lastStart);
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.schedule(); }, delay);
      this.timer.unref();
      return;
    }
    const capture = this.pending;
    this.pending = undefined;
    this.running = true;
    this.lastStart = performance.now();
    void this.capture(capture).finally(() => { this.running = false; this.schedule(); });
  }

  private dropConnection(): void {
    const cdp = this.cdp;
    this.cdp = undefined;
    this.attachment = undefined;
    this.stopDisconnect?.(); this.stopDisconnect = undefined;
    this.stopEvents?.(); this.stopEvents = undefined;
    cdp?.close();
  }

  private fail(capture: Capture): void {
    if (!this.current(capture)) return;
    this.invalidate();
    this.dropConnection();
    this.options.onError();
  }

  private async connection(): Promise<BrowserCdp | undefined> {
    if (this.cdp) return this.cdp;
    const url = await this.options.getCdpUrl();
    if (this.closed) return;
    const cdp = await BrowserCdp.connect(url, { imageResponses: true });
    if (this.closed) { cdp.close(); return; }
    this.cdp = cdp;
    this.stopDisconnect = cdp.onDisconnect(() => {
      if (this.cdp !== cdp) return;
      const desired = this.desired;
      this.dropConnection();
      if (desired) this.fail(desired);
    });
    this.stopEvents = cdp.onEvent(event => {
      if (event.method === "Target.detachedFromTarget" && event.params.sessionId === this.attachment?.sessionId) this.attachment = undefined;
    });
    return cdp;
  }

  private async attach(cdp: BrowserCdp, capture: Capture): Promise<string | undefined> {
    if (this.attachment?.targetId === capture.targetId) return this.attachment.sessionId;
    const previous = this.attachment;
    this.attachment = undefined;
    if (previous) await cdp.request("Target.detachFromTarget", { sessionId: previous.sessionId });
    if (!this.current(capture)) return;
    const attached = await cdp.request("Target.attachToTarget", { targetId: capture.targetId, flatten: true });
    if (typeof attached.sessionId !== "string" || !attached.sessionId) throw new Error("Missing private capture attachment");
    if (this.closed || this.cdp !== cdp) return;
    this.attachment = { targetId: capture.targetId, sessionId: attached.sessionId };
    return attached.sessionId;
  }

  private async capture(capture: Capture): Promise<void> {
    try {
      if (!capture.targetId) throw new Error("Missing private capture target");
      if (capture.viewport) dimensions(capture.viewport.width, capture.viewport.height);
      const cdp = await this.connection();
      if (!cdp || !this.current(capture)) return;
      const sessionId = await this.attach(cdp, capture);
      if (!sessionId || !this.current(capture)) return;
      const metrics = await cdp.request("Page.getLayoutMetrics", {}, sessionId);
      if (!this.current(capture)) return;
      const visual = metrics.cssVisualViewport;
      if (!visual || typeof visual !== "object" || !("pageX" in visual) || !("pageY" in visual) || !("clientWidth" in visual) || !("clientHeight" in visual) || typeof visual.pageX !== "number" || !Number.isFinite(visual.pageX) || typeof visual.pageY !== "number" || !Number.isFinite(visual.pageY)) throw new Error("Missing private CSS viewport");
      const size = capture.viewport ?? dimensions(visual.clientWidth, visual.clientHeight);
      this.lastStart = performance.now();
      const result = await cdp.request("Page.captureScreenshot", {
        format: "jpeg", quality: 65, fromSurface: true,
        clip: { x: visual.pageX, y: visual.pageY, ...size, scale: 1 },
        captureBeyondViewport: false,
      }, sessionId);
      if (!this.current(capture)) return;
      validateJpeg(result.data, size.width, size.height);
      this.options.onFrame({ type: "frame", data: result.data, ...size });
    } catch {
      // Protocol responses and page pixels never enter error messages, logs, or model results.
      this.fail(capture);
    }
  }
}
