// Requester (RESOLVER_SERVICE 2.5, SOT D14, D17, D18). Waktu dan I/O diinjeksi; pemanggil menjalankan
// `setInterval(r.flush, SOT.resolver.REQUEST_FLUSH_SEC * 1000)`.
import { resolve, SOT, type Snapshot } from "@movemarket/shared";
import type { Requester, TrackedMarket, TxQueue } from "../contracts.ts";

const R = SOT.resolver;

export interface RequesterDeps {
  tx: Pick<TxQueue, "send">;
  market(id: bigint): TrackedMarket | undefined;
  /** Snapshot dari sourceRequest(gameRef) (sumber yang sama dengan CRE), diparse dengan parseLichessJson / parsePgn. */
  fetchExport(gameRef: string): Promise<Snapshot>;
  /** getMarkets(ids) lalu saring status OPEN. */
  openIds(ids: bigint[]): Promise<bigint[]>;
  nowSec(): number;
  log(event: string, data: Record<string, unknown>): void;
  /** REQUEST_MAX_BATCH dari env; default SOT. */
  maxBatch?: number;
}

interface Inflight { gameRef: string; sentAt: number; retries: number }
/** Id yang tetap OPEN setelah MAX_RETRIES: menunggu keputusan operator (adminVoid). */
export interface CreFailed { id: bigint; gameRef: string; at: number }

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function createRequester(d: RequesterDeps): Requester & { flush(): Promise<void>; failed(): CreFailed[] } {
  const maxBatch = d.maxBatch ?? R.REQUEST_MAX_BATCH;
  const failed = new Map<bigint, CreFailed>();
  const pending = new Map<string, Set<bigint>>();
  const inflight = new Map<bigint, Inflight>();
  const mismatchLogged = new Set<bigint>();
  let running: Promise<void> | null = null;

  async function send(gameRef: string, ids: bigint[], retries: number) {
    for (const batch of chunks(ids, maxBatch)) {
      try {
        await d.tx.send({ kind: "requestResolution", gameRef, ids: batch });
      } catch (err) {
        d.log("request_failed", { gameRef, ids: batch.map(String), err: String(err) });
        // Kirim pertama gagal: kembali ke pending.
        if (retries === 0) {
          for (const id of batch) pending.get(gameRef)?.add(id) ?? pending.set(gameRef, new Set([id]));
          continue;
        }
        // Retry gagal tetap dihitung terkirim, supaya menunggu jadwal berikutnya (2.5), bukan diulang tiap flush.
      }
      for (const id of batch) inflight.set(id, { gameRef, sentAt: d.nowSec(), retries });
    }
  }

  async function flushPending() {
    for (const [gameRef, set] of [...pending]) {
      let snap: Snapshot;
      try {
        snap = await d.fetchExport(gameRef);
      } catch (err) {
        d.log("export_failed", { gameRef, err: String(err) });
        continue;
      }
      const ready: bigint[] = [];
      for (const id of set) {
        const m = d.market(id);
        if (!m || m.final !== null) {
          set.delete(id);
          continue;
        }
        const outcome = resolve(snap, m);
        if (outcome === "PENDING") continue; // tunggu flush berikutnya
        if (outcome !== m.provisional) {
          if (!mismatchLogged.has(id)) d.log("mismatch_pre", { id: String(id), gameRef, export: outcome, provisional: m.provisional });
          mismatchLogged.add(id);
          continue;
        }
        set.delete(id);
        mismatchLogged.delete(id);
        // D18, dicek selambat mungkin supaya BetPlaced yang telat terlihat tetap terhitung.
        if (m.poolYes + m.poolNo === 0n) d.log("skip_no_stakes", { id: String(id), gameRef });
        else ready.push(id);
      }
      if (!set.size) pending.delete(gameRef);
      if (ready.length) await send(gameRef, ready, 0);
    }
  }

  async function retryInflight() {
    const now = d.nowSec();
    const due = new Map<string, bigint[]>();
    for (const [id, f] of inflight) {
      const wait = R.FINAL_WAIT_SEC + (f.retries < R.MAX_RETRIES ? R.RETRY_BACKOFF_SEC[f.retries]! : 0);
      if (now >= f.sentAt + wait) due.set(f.gameRef, [...(due.get(f.gameRef) ?? []), id]);
    }
    for (const [gameRef, ids] of due) {
      let stillOpen: Set<bigint>;
      try {
        stillOpen = new Set(await d.openIds(ids));
      } catch (err) {
        d.log("read_markets_failed", { gameRef, err: String(err) });
        continue;
      }
      const byRetries = new Map<number, bigint[]>();
      for (const id of ids) {
        const f = inflight.get(id);
        if (!f) continue; // settled() saat menunggu openIds
        if (!stillOpen.has(id)) {
          inflight.delete(id);
        } else if (f.retries >= R.MAX_RETRIES) {
          inflight.delete(id);
          failed.set(id, { id, gameRef, at: now });
          d.log("cre_failed", { id: String(id), gameRef });
        } else {
          byRetries.set(f.retries + 1, [...(byRetries.get(f.retries + 1) ?? []), id]);
        }
      }
      for (const [retries, retryIds] of byRetries) await send(gameRef, retryIds, retries);
    }
  }

  /** Satu flush berjalan pada satu waktu; pemanggil yang datang saat flush berjalan menunggu flush itu. */
  function flush(): Promise<void> {
    running ??= (async () => {
      try {
        await flushPending();
        await retryInflight();
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    add(gameRef, ids) {
      const set = pending.get(gameRef) ?? new Set<bigint>();
      for (const id of ids) if (!inflight.has(id)) set.add(id);
      pending.set(gameRef, set);
      if (set.size >= maxBatch) void flush();
    },
    settled(id) {
      inflight.delete(id);
      failed.delete(id);
      mismatchLogged.delete(id);
      for (const set of pending.values()) set.delete(id);
    },
    flush,
    failed: () => [...failed.values()],
  };
}
