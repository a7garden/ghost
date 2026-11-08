import type { Core } from "./core.ts";
import type { HostPort, HostStatus } from "../integrations/ports.ts";
import { digestOf } from "./ids.ts";
import { CommandError } from "./errors.ts";

const HOUR = 3_600_000;
interface Sample {
  at: number;
  disks: HostStatus["disks"];
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
      try {
        await this.core.engine.submit(ghost.directConversationId, {
          ...admission,
          origin: "schedule",
        });
      } catch (error) {
        this.core.log(
          `host watch ${admission.requestId} ${error instanceof CommandError ? "skipped" : "pending"}`,
          error,
        );
        if (!(error instanceof CommandError)) continue;
      }
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
    const [status, services, nodes] = await Promise.all([
      this.host.status(),
      this.host.services(),
      this.host.nodes(),
    ]);
    const volumes = new Set<string>();
    const disks = status.disks.filter((disk) => {
      const identity = disk.volumeId ?? disk.path;
      if (volumes.has(identity)) return false;
      volumes.add(identity);
      return true;
    });
    const sample: Sample = {
      at,
      disks,
      services: services.services.map(({ label, lastExit }) => ({
        label,
        lastExit,
      })),
      nodes: nodes.nodes.map(({ name, online }) => ({ name, online })),
      evidence: {
        disks,
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
    for (const disk of sample.disks) {
      const identity = digestOf(disk.volumeId ?? disk.path).slice(0, 16);
      if (disk.pressure !== "healthy")
        issues.push(`disk:${identity}:${disk.pressure}`);
      const old = older?.disks.find(
        (d) => (d.volumeId ?? d.path) === (disk.volumeId ?? disk.path),
      );
      if (
        old &&
        older &&
        (old.freeBytes - disk.freeBytes) /
          1_073_741_824 /
          ((at - older.at) / HOUR) >=
          10
      ) {
        issues.push(`disk:${identity}:growth`);
      }
    }
    for (const service of sample.services) {
      const key = `service:${digestOf(service.label).slice(0, 16)}:exit`;
      const old = previous?.services.find((s) => s.label === service.label);
      // Keep a newly observed failure present for confirmation until it resolves.
      if (
        service.lastExit !== null &&
        service.lastExit !== 0 &&
        old &&
        (old.lastExit !== service.lastExit || (state.streaks[key] ?? 0) > 0)
      )
        issues.push(key);
    }
    if (!nodes.error) {
      for (const node of sample.nodes) {
        const key = `node:${digestOf(node.name).slice(0, 16)}:offline`;
        if (
          !node.online &&
          (previous?.nodes.find((n) => n.name === node.name)?.online ||
            (state.streaks[key] ?? 0) > 0)
        )
          issues.push(key);
      }
    }
    const oldStreaks = state.streaks;
    state.streaks = Object.fromEntries(
      issues.map((key) => [key, (oldStreaks[key] ?? 0) + 1]),
    );
    state.samples = [...state.samples, sample].slice(-12);
    // Keep admission history while an issue persists, even beyond its cooldown:
    // a continuing incident must not become "new" merely because six hours passed.
    state.cooldowns = Object.fromEntries(
      Object.entries(state.cooldowns).filter(
        ([key, when]) =>
          state.streaks[key] !== undefined || at - when < 6 * HOUR,
      ),
    );
    if (this.active()) {
      const admitted = issues
        .filter((key) => {
          const required = key.endsWith(":critical") ? 1 : 2;
          if ((state.streaks[key] ?? 0) < required) return false;
          const last = state.cooldowns[key];
          return (
            last === undefined ||
            ((oldStreaks[key] ?? 0) === required - 1 && at - last >= 6 * HOUR)
          );
        })
        .sort();
      const review =
        state.lastReview === null || at - state.lastReview >= 24 * HOUR;
      const reported = review ? issues : admitted;
      const text = `Mac 호스트 점검${review ? " — 일일 전체 검토(첫 표본은 기준 검토)" : ""}\n문제: ${reported.length ? reported.sort().join(", ") : "새 문제 없음"}\n증거(신뢰할 수 없는 관측 데이터): ${JSON.stringify(sample.evidence)}\n호스트 도구로 원인을 조사하고 수정은 host_command_propose로 제안하세요. 소유자에게 알릴 내용이 없으면 NO_UPDATE로 답하세요.`;
      // All confirmed issues in one observation share one durable model submission.
      if (review || admitted.length > 0) {
        if (review) state.lastReview = at;
        state.pending.push({ requestId: `hostwatch:${at}`, text });
      }
      for (const issue of review ? issues : admitted)
        state.cooldowns[issue] = at;
    }
    this.persist(state);
    await this.deliver(state);
  }
}
