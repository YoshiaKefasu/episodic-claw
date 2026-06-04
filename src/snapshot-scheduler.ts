// src/snapshot-scheduler.ts — Drive the weekly forgotten-episode sweep.
//
// Trigger design (2026-06-01):
//   - setInterval every 5 minutes
//   - each tick evaluates two gates:
//     1. window  — Sunday 03:00-03:59 (in local time)
//     2. age     — lastRunAt is missing or > 7.04 days old (catch-up)
//   - run lock prevents re-entry: if a sweep is already in progress
//     and the next tick fires, the new tick is silently skipped
//   - unref() so the timer does not keep the gateway alive
//
// Kill switch: EPISODIC_DISABLE_SNAPSHOT_WORKER=1 (snapshot-worker.ts).
//
// Logging: gated by DEBUG_EPISODIC_SNAPSHOT (consistent with
// DEBUG_EPISODIC_WAL / DEBUG_EPISODIC_RECALL_FINGERPRINT pattern).

import { getEnvVal } from "./env-var";
import { runSnapshotSweep, isSnapshotWorkerDisabled, type SnapshotSweepResult } from "./snapshot-worker";
import type { EpisodicCoreClient } from "./rpc-client";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_TARGET_DAY_OF_WEEK = 0;  // 0 = Sunday (JS Date.getDay)
const SWEEP_TARGET_HOUR = 3;          // 03:00-03:59 local
const CATCHUP_THRESHOLD_DAYS = 7.04;  // 7 days + 1 hour safety margin

const LAST_RUN_KEY = "meta:forgotten_snapshot_last_run";

function logDebug(payload: string | Record<string, unknown>): void {
  if (getEnvVal("DEBUG_EPISODIC_SNAPSHOT")) {
    if (typeof payload === "string") {
      console.log(`[snapshot-scheduler] ${payload}`);
    } else {
      console.log(`[snapshot-scheduler] ${JSON.stringify(payload)}`);
    }
  }
}

export class SnapshotScheduler {
  private timer: NodeJS.Timeout | null = null;
  private sweepInProgress = false;
  private client?: EpisodicCoreClient;
  private agentWs: string;
  private forgettingEnabled: boolean;

  constructor(agentWs: string, opts?: { forgettingEnabled?: boolean }) {
    this.agentWs = agentWs;
    this.forgettingEnabled = opts?.forgettingEnabled ?? false;
  }

  setClient(client: EpisodicCoreClient): void {
    this.client = client;
  }

  start(): void {
    if (isSnapshotWorkerDisabled()) {
      logDebug("snapshot scheduler disabled via EPISODIC_DISABLE_SNAPSHOT_WORKER=1");
      return;
    }
    if (!this.forgettingEnabled) {
      logDebug("snapshot scheduler disabled via forgettingEpisodic.enabled=false");
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        logDebug({ event: "tick_failed", err: err instanceof Error ? err.message : String(err) });
      });
    }, CHECK_INTERVAL_MS);
    this.timer.unref();
    logDebug({ event: "started", intervalMs: CHECK_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Public entry point so a future Phase-5 caller (e.g. cron RPC) can
   * trigger a sweep without waiting for the scheduler tick.
   */
  async runNow(reason: "scheduled" | "catchup" | "manual" = "manual"): Promise<SnapshotSweepResult | null> {
    if (!this.client) {
      throw new Error("SnapshotScheduler.runNow called before setClient");
    }
    return this.runSweep(reason);
  }

  /** Test seam — exposed for the unit test that exercises the lock. */
  get isSweepInProgress(): boolean {
    return this.sweepInProgress;
  }

  private async tick(): Promise<void> {
    if (!this.client) return;
    if (this.sweepInProgress) return;

    const now = new Date();
    const lastRun = await this.readLastRun().catch(() => 0);
    const daysSince = lastRun > 0 ? (now.getTime() - lastRun) / 86_400_000 : Infinity;

    const inWindow =
      now.getDay() === SWEEP_TARGET_DAY_OF_WEEK &&
      now.getHours() === SWEEP_TARGET_HOUR &&
      // Cooldown: don't refire within the same window after a successful sweep.
      // This prevents the 5-min tick from re-entering 12 times between 03:00-03:59.
      daysSince >= 1 / 24;  // at least 1 hour since last run
    const dueByAge = daysSince >= CATCHUP_THRESHOLD_DAYS;

    if (!inWindow && !dueByAge) return;

    const reason: "scheduled" | "catchup" = inWindow ? "scheduled" : "catchup";
    logDebug({ event: "tick_fire", reason, daysSince: Number.isFinite(daysSince) ? daysSince : null });
    await this.runSweep(reason);
  }

  private async runSweep(reason: "scheduled" | "catchup" | "manual"): Promise<SnapshotSweepResult | null> {
    if (!this.client) return null;
    if (this.sweepInProgress) return null;
    this.sweepInProgress = true;
    try {
      const result = await runSnapshotSweep({ client: this.client, agentWs: this.agentWs });
      await this.writeLastRun(Date.now());
      logDebug({
        event: "sweep_done",
        reason,
        candidates: result.candidates,
        summarised: result.summarised,
        deleted: result.deleted,
        fileWritten: result.fileWritten,
        filePath: result.filePath ?? null,
        durationMs: result.durationMs,
      });
      return result;
    } catch (err) {
      logDebug({ event: "sweep_failed", err: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      this.sweepInProgress = false;
    }
  }

  private async readLastRun(): Promise<number> {
    if (!this.client) return 0;
    const raw = await this.client.stateGet(LAST_RUN_KEY, this.agentWs, "snapshot-scheduler");
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  private async writeLastRun(ts: number): Promise<void> {
    if (!this.client) return;
    await this.client.stateSet(LAST_RUN_KEY, String(ts), this.agentWs, "snapshot-scheduler");
  }
}
