// Alur per update partai (RESOLVER_SERVICE 2.1): registry.apply -> SSE ply/game_end -> engine.
// Satu rantai promise per partai supaya update partai yang sama diproses berurutan.
import type { GameRegistry, GameState, GameUpdate, MarketEngine, SseHub } from "../contracts.ts";

export interface PipelineDeps {
  registry: GameRegistry;
  engine: Pick<MarketEngine, "onPly" | "onCorrection">;
  sse: Pick<SseHub, "publish">;
  nowSec(): number;
  log(event: string, data: Record<string, unknown>): void;
}

export function createGamePipeline(d: PipelineDeps) {
  /** Partai yang di-untrack: tetap diikuti untuk hasil sementara, tanpa kunci dan tanpa pasar baru. */
  const untracked = new Set<string>();
  const tails = new Map<string, Promise<void>>();

  return {
    onUpdate(u: GameUpdate): void {
      const r = d.registry.apply(u);
      if (r.kind === "unchanged") return;
      const st = r.state;
      const prevTail = tails.get(st.gameRef) ?? Promise.resolve();
      const next = prevTail.then(async () => {
        if (r.kind === "corrected") d.log("correction", { gameRef: st.gameRef, firstDiffPly: r.firstDiffPly });
        const ply = st.sans.length;
        // Satu event untuk ply terakhir; fen hanya diketahui untuk posisi terakhir (replay memuat 20 ply sekaligus).
        if (ply > 0) d.sse.publish("ply", { gameRef: st.gameRef, ply, san: st.sans[ply - 1]!, fen: st.fen, isReplay: st.isReplay, at: Date.now() });
        if (st.ended && st.result) d.sse.publish("game_end", { gameRef: st.gameRef, result: st.result });
        if (r.kind === "corrected" || untracked.has(st.gameRef)) d.engine.onCorrection(st);
        else await d.engine.onPly(st, d.nowSec());
      }).catch((err) => d.log("ply_failed", { gameRef: st.gameRef, err: String(err) }));
      tails.set(st.gameRef, next);
    },
    track(gameRef: string): void {
      untracked.delete(gameRef);
    },
    untrack(gameRef: string): void {
      untracked.add(gameRef);
    },
    isUntracked: (gameRef: string) => untracked.has(gameRef),
    untracked: () => [...untracked],
    /** Selesai saat semua update yang sudah masuk selesai diproses (untuk test dan shutdown). */
    idle: async () => void (await Promise.all(tails.values())),
  };
}
