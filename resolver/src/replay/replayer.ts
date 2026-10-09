// Replay partai selesai (RESOLVER_SERVICE.md 2.10, SOT D16). Update masuk ke alur yang sama dengan live.
// tick() dipanggil tiap detik: memajukan ply, scheduler otomatis, dan aturan penonton.
import { SOT, type Speed } from "@movemarket/shared";
import type { GameUpdate, MarketEngine, Replayer, SseHub } from "../contracts.ts";
import { gameFromExport } from "../lichess/exportGame.ts";

export interface ReplayerDeps {
  fetchGame(gameId: string): Promise<unknown>;
  onUpdate(u: GameUpdate): void;
  sse: Pick<SseHub, "publish" | "viewers">;
  engine: Pick<MarketEngine, "setSpawning">;
  /** Ada pasar partai ini yang punya stake dan belum final. */
  hasPendingStakes(gameRef: string): boolean;
  /** Jumlah partai live (bukan replay) yang belum selesai. */
  liveGames(): number;
  pool: string[];
  startPly: number;
  plyIntervalSec: number;
  autoIdleMin: number;
  requiresViewer: boolean;
  viewerGraceSec: number;
  log(event: string, data: Record<string, unknown>): void;
  now?: () => number;
}

interface Active { full: GameUpdate; ply: number; intervalMs: number; nextAt: number }

export function createReplayer(d: ReplayerDeps): Replayer & { tick(): Promise<void>; active(): string | null } {
  const now = d.now ?? Date.now;
  let active: Active | null = null;
  let lastLiveAt = now();
  let lastViewerAt = now();
  let spawning = true;
  let poolIdx = 0;
  let starting = false;

  const emit = (a: Active) => {
    const ended = a.ply >= a.full.sans.length;
    const { result, ...rest } = a.full;
    d.onUpdate({ ...rest, sans: a.full.sans.slice(0, a.ply), ended, ...(ended && result ? { result } : {}) });
    if (ended) active = null;
  };

  const start = async (gameId: string, plyIntervalSec = d.plyIntervalSec) => {
    if (!/^[A-Za-z0-9]{8}$/.test(gameId)) throw new Error(`gameId tidak valid: ${gameId}`);
    const full = gameFromExport(await d.fetchGame(gameId), true);
    if (!full.ended || !(SOT.replay.poolSpeeds as Speed[]).includes(full.speed)) {
      d.log("replay_rejected", { gameId, speed: full.speed, ended: full.ended });
      throw new Error(`replay_rejected: ${gameId} (${full.speed}${full.ended ? "" : ", belum selesai"})`);
    }
    if (active) d.log("replay_replaced", { gameRef: active.full.gameRef });
    const intervalMs = plyIntervalSec * 1000;
    active = { full, ply: Math.min(d.startPly, full.sans.length), intervalMs, nextAt: now() + intervalMs };
    d.sse.publish("replay_starting", { gameRef: full.gameRef });
    d.log("replay_started", { gameRef: full.gameRef, ply: active.ply });
    emit(active);
    return full.gameRef;
  };

  const tick = async () => {
    const t = now();
    if (d.liveGames() > 0) lastLiveAt = t;
    if (d.sse.viewers() > 0) lastViewerAt = t;

    // D16: tanpa penonton selama VIEWER_GRACE_SEC berhenti membuat pasar baru.
    const watched = t - lastViewerAt < d.viewerGraceSec * 1000;
    if (watched !== spawning) {
      spawning = watched;
      d.engine.setSpawning(watched);
      d.log(watched ? "spawning_resumed" : "spawning_paused", {});
    }

    if (active && t >= active.nextAt) {
      // Tanpa penonton: tetap maju selama ada pasar ber-stake yang belum final, lalu jeda.
      if (watched || d.hasPendingStakes(active.full.gameRef)) {
        active.ply++;
        active.nextAt = t + active.intervalMs;
        emit(active);
      }
    }

    const idle = t - lastLiveAt >= d.autoIdleMin * 60_000;
    const viewerOk = !d.requiresViewer || d.sse.viewers() > 0;
    if (!active && !starting && idle && viewerOk && d.pool.length) {
      const id = d.pool[poolIdx++ % d.pool.length]!;
      starting = true;
      try { await start(id); } catch (err) { d.log("auto_replay_failed", { gameId: id, err: String(err) }); }
      starting = false;
    }
  };

  return {
    start,
    stop() {
      if (active) d.log("replay_stopped", { gameRef: active.full.gameRef });
      active = null;
    },
    tick,
    active: () => active?.full.gameRef ?? null,
  };
}
