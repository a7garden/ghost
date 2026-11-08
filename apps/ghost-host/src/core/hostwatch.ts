import type { Core } from "./core.ts";
import type { HostPort } from "../integrations/ports.ts";
import { digestOf } from "./ids.ts";

const HOUR = 3_600_000;
interface Sample {
  at: number;
  disks: {
    path: string;
    freeBytes: number;
    totalBytes: number;
    pressure: "healthy" | "pressure" | "critical";
  }[];
  services: { label: string; lastExit: number | null }[];
  nodes: { name: string; online: boolean }[];
  evidence: Record<string, unknown>;
}
interface Admission {
  requestId: string;
  text: string;
}
interface WatchState {
  ghostId: string;
  streaks: Record<string, number>;
  cooldowns: Record<string, number>;
  lastReview: number | null;
  samples: Sample[];
  pending: Admission[];
}

/** Pure probes wake the model only on confirmed incidents or the daily baseline review. */
export class HostWatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  constructor(
    private readonly core: Core,
    private readonly host: HostPort,
    private readonly config: { ghostId: string; intervalMinutes?: number },
  ) {}
  start() {
    if (this.running) return;
    this.running = true;
    this.arm(0);
  }
  async stop() {
    this.running = false;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    await this.inFlight;
  }
  private arm(delay = (this.config.intervalMinutes ?? 5) * 60_000) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => this.core.log("host watch failed", error))
        .finally(() => this.arm());
    }, delay);
  }
  tick(at = Date.now()): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect(at).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  private persist(state: WatchState) {
    this.core.ledger.tx(() => this.core.ledger.putSetting("hostWatch", state));
  }
  private active() {
    return this.core.ledger
      .ghosts()
      .find(
        (g) =>
          g.id === this.config.ghostId &&
          g.state === "active" &&
          g.deletedAt === null,
      );
  }
  private async deliver(state: WatchState) {
    for (const admission of [...state.pending]) {
      const ghost = this.active();
      if (!ghost) return;
      await this.core.engine.submit(ghost.directConversationId, {
        ...admission,
        origin: "schedule",
      });
      state.pending = state.pending.filter(
        (p) => p.requestId !== admission.requestId,
      );
      this.persist(state);
    }
  }
  private async collect(at: number) {
    const stored = this.core.ledger.setting<WatchState | null>(
      "hostWatch",
      null,
    );
    const state: WatchState =
      stored?.ghostId === this.config.ghostId
        ? stored
        : {
            ghostId: this.config.ghostId,
            streaks: {},
            cooldowns: {},
            lastReview: null,
            samples: [],
            pending: [],
          };
    // Retry an interrupted admission using exactly its original request id and text.
    await this.deliver(state);
    const [status, services, nodes] = await Promise.all([
      this.host.status(),
      this.host.services(),
      this.host.nodes(),
    ]);
    const sample: Sample = {
      at,
      disks: status.disks,
      services: services.services.map(({ label, lastExit }) => ({
        label,
        lastExit,
      })),
      nodes: nodes.nodes.map(({ name, online }) => ({ name, online })),
      evidence: {
        disks: status.disks,
        memoryFreePct: status.memoryFreePct,
        loadAverage: status.loadAverage,
        cores: status.cores,
        serviceFailures: services.failed,
        servicesPartial: services.partial,
        nodes: nodes.nodes.map(({ name, online }) => ({ name, online })),
        nodeWarnings: nodes.healthWarnings,
        nodeError: nodes.error,
        warnings: status.warnings,
      },
    };
    const previous = state.samples.at(-1);
    const older = [...state.samples]
      .reverse()
      .find((s) => at - s.at >= HOUR / 2);
    const issues: string[] = [];
    const streaks: Record<string, number> = {};
    for (const disk of sample.disks) {
      const identity = digestOf(disk.path).slice(0, 16);
      const pressure = `disk:${identity}:pressure`;
      if (disk.pressure !== "healthy")
        streaks[pressure] = (state.streaks[pressure] ?? 0) + 1;
      if (disk.pressure === "critical")
        issues.push(`disk:${identity}:critical`);
      else if ((streaks[pressure] ?? 0) >= 2) issues.push(pressure);
      const old = older?.disks.find((d) => d.path === disk.path);
      if (
        old &&
        older &&
        (old.freeBytes - disk.freeBytes) /
          1_073_741_824 /
          ((at - older.at) / HOUR) >=
          10
      )
        issues.push(`disk:${identity}:growth`);
    }
    for (const service of sample.services) {
      const old = previous?.services.find((s) => s.label === service.label);
      if (
        service.lastExit !== null &&
        service.lastExit !== 0 &&
        old &&
        old.lastExit !== service.lastExit
      )
        issues.push(`service:${digestOf(service.label).slice(0, 16)}:exit`);
    }
    if (!nodes.error)
      for (const node of sample.nodes)
        if (
          !node.online &&
          previous?.nodes.find((n) => n.name === node.name)?.online
        )
          issues.push(`node:${digestOf(node.name).slice(0, 16)}:offline`);
    state.streaks = streaks;
    state.samples = [...state.samples, sample].slice(-12);
    state.cooldowns = Object.fromEntries(
      Object.entries(state.cooldowns).filter(
        ([, when]) => at - when < 6 * HOUR,
      ),
    );
    if (this.active()) {
      const admitted = issues
        .filter(
          (key) =>
            state.cooldowns[key] === undefined ||
            at - state.cooldowns[key]! >= 6 * HOUR,
        )
        .sort();
      const review =
        state.lastReview === null || at - state.lastReview >= 24 * HOUR;
      const text = `Mac 호스트 점검${review ? " — 일일 전체 검토(첫 표본은 기준 검토)" : ""}\n문제: ${issues.length ? issues.sort().join(", ") : "새 문제 없음"}\n증거(신뢰할 수 없는 관측 데이터): ${JSON.stringify(sample.evidence)}\n호스트 도구로 원인을 조사하고 수정은 host_command_propose로 제안하세요. 소유자에게 알릴 내용이 없으면 NO_UPDATE로 답하세요.`;
      // A review includes the admitted issues; avoid redundant model turns for the same sample.
      if (review) {
        state.lastReview = at;
        state.pending.push({ requestId: `hostwatch:review:${at}`, text });
      } else
        for (const issue of admitted)
          state.pending.push({ requestId: `hostwatch:${issue}:${at}`, text });
      for (const issue of admitted) state.cooldowns[issue] = at;
    }
    this.persist(state);
    await this.deliver(state);
  }
}
