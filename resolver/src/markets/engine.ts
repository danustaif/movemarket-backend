// Orkestrator per ply (RESOLVER_SERVICE 2.3 sampai 2.4). Urutan wajib: kunci -> hasil sementara -> rencana.
// Semua dependensi diinjeksi. SSE market_created dikirim dari event MarketCreated (id baru ada di event) yang
// watcher terima dari receipt createMarkets (index.ts membungkus txQueue), bukan dari engine.
import { SOT, type FinalOutcome } from "@movemarket/shared";
import type { GameState, MarketEngine, Requester, SseHub, TrackedMarket, TxQueue } from "../contracts.ts";
import { locksDue } from "./locker.ts";
import { planMarkets } from "./planner.ts";
import { provisionalChanges } from "./provisional.ts";
import type { MemoryMarketStore } from "./store.ts";

const P = SOT.planner;
/** Waktu pembuatan pasar: lockTime awal (resolveDeadline - RESOLVE_DEADLINE_SEC) dikurangi BET_WINDOW_SEC. */
const createdAt = (m: TrackedMarket) => m.resolveDeadline - P.RESOLVE_DEADLINE_SEC - P.BET_WINDOW_SEC;

export interface EngineDeps {
  tx: Pick<TxQueue, "send">;
  sse: Pick<SseHub, "publish">;
  requester: Pick<Requester, "add">;
  store: Pick<MemoryMarketStore, "byGame" | "setProvisional">;
  log(event: string, data: Record<string, unknown>): void;
}

export function createMarketEngine(d: EngineDeps): MarketEngine {
  /** Partai yang sedang tidak boleh membuat pasar baru (D16, replay tanpa penonton). */
  const paused = new Set<string>();
  /** id yang lockMarkets-nya sudah terkirim; store baru tahu lewat event MarketLocked. */
  const lockSent = new Set<bigint>();
  /** Ply terakhir yang sudah direncanakan per partai, supaya update di ply yang sama tidak spawn ulang. */
  const plannedPly = new Map<string, number>();
  /** Awal run partai (newRun). Pasar yang dibuat sebelumnya milik run lama dan tidak dilihat planner. */
  const runStart = new Map<string, number>();

  /** Kunci ply (D11), prioritas tertinggi. Dijalankan di setiap update partai, termasuk koreksi dan untrack. */
  async function lock(state: GameState, nowSec: number) {
    const ref = state.gameRef;
    const lockIds = locksDue(state, d.store.byGame(ref), nowSec).filter((id) => !lockSent.has(id));
    if (!lockIds.length) return;
    for (const id of lockIds) lockSent.add(id);
    try {
      await d.tx.send({ kind: "lockMarkets", ids: lockIds });
      // Waktu blok tidak ada di receipt; nowSec (waktu chain) adalah perkiraan. MarketLocked membawa nilai pastinya.
      d.sse.publish("market_locked", { gameRef: ref, marketIds: lockIds.map(String), lockTime: nowSec });
    } catch (err) {
      for (const id of lockIds) lockSent.delete(id); // dicoba lagi di update berikutnya
      d.log("lock_failed", { gameRef: ref, ids: lockIds.map(String), err: String(err) });
    }
  }

  function applyProvisional(state: GameState, markets: readonly TrackedMarket[]) {
    const ready: bigint[] = [];
    for (const { id, outcome } of provisionalChanges(state, markets)) {
      d.store.setProvisional(id, outcome);
      if (outcome === "PENDING") continue;
      d.sse.publish("provisional", { gameRef: state.gameRef, marketId: id.toString(), outcome: outcome as FinalOutcome });
      ready.push(id);
    }
    // Requester menyaring pasar tanpa stake (D18) dan yang sudah in-flight.
    if (ready.length) d.requester.add(state.gameRef, ready);
  }

  return {
    async onPly(state, nowSec, spawn = true) {
      const ref = state.gameRef;
      await lock(state, nowSec);

      applyProvisional(state, d.store.byGame(ref).filter((m) => m.lockTime <= nowSec && !m.requested && m.final === null));

      const ply = state.sans.length;
      if (!spawn || paused.has(ref) || ply <= (plannedPly.get(ref) ?? 0)) return;
      const since = runStart.get(ref) ?? -Infinity;
      const params = planMarkets(state, d.store.byGame(ref).filter((m) => createdAt(m) >= since), nowSec);
      if (!params.length) return;
      plannedPly.set(ref, ply);
      try {
        await d.tx.send({ kind: "createMarkets", params });
      } catch (err) {
        d.log("create_failed", { gameRef: ref, ply, err: String(err) });
      }
    },

    async onCorrection(state, nowSec) {
      await lock(state, nowSec);
      applyProvisional(state, d.store.byGame(state.gameRef).filter((m) => m.final === null));
    },

    marketsOf(gameRef) {
      const since = runStart.get(gameRef) ?? -Infinity;
      return d.store.byGame(gameRef).filter((m) =>
        createdAt(m) >= since || (m.final === null && m.poolYes + m.poolNo > 0n));
    },

    newRun(gameRef, nowSec) {
      runStart.set(gameRef, nowSec);
      plannedPly.delete(gameRef);
    },

    setSpawning(gameRef, enabled) {
      if (enabled) paused.delete(gameRef);
      else paused.add(gameRef);
    },
  };
}
