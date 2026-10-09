// Alur per update partai dengan registry, engine, store, dan replayer asli. Hanya tx yang palsu:
// tx memancarkan MarketCreated / MarketLocked ke store seperti watcher.
import { expect, test } from "bun:test";
import type { GameUpdate, LiveMarketEvent, ResolverTx } from "../src/contracts.ts";
import { createGamePipeline } from "../src/games/pipeline.ts";
import { createGameRegistry } from "../src/games/registry.ts";
import { createMarketEngine } from "../src/markets/engine.ts";
import { MemoryMarketStore } from "../src/markets/store.ts";
import { createReplayer } from "../src/replay/replayer.ts";
import { FIXTURES, quietSans } from "./helpers.ts";

const BCAST = "lichess:study:cbVdruwJ:fGXnnaOp";
const rapid = { ...(await Bun.file(new URL("game-export.ongoing-rapid.json", FIXTURES)).json()), status: "resign", winner: "black" }; // 44 ply
const RAPID = `lichess:game:${rapid.id}`;

const bcast = (sans: string[], p: Partial<GameUpdate> = {}): GameUpdate => ({
  gameRef: BCAST, source: "broadcast", speed: "classical", white: { name: "W" }, black: { name: "B" },
  sans, ended: false, isReplay: false, ...p,
});

/** Satu proses resolver. `store` dibagi antar world untuk mensimulasikan restart (store dibangun ulang dari chain). */
function world(store = new MemoryMarketStore(async () => 0n)) {
  let clockMs = 1_000_000_000;
  const nowSec = () => Math.floor(clockMs / 1000);
  const txs: ResolverTx[] = [];
  let seq = store.all().length;
  const emit = (e: Pick<LiveMarketEvent, "name" | "args">) =>
    store.apply({ ...e, txHash: `0x${(++seq).toString(16).padStart(64, "0")}`, blockNumber: 1n } as LiveMarketEvent);
  const engine = createMarketEngine({
    tx: {
      send: async (t) => {
        txs.push(t);
        if (t.kind === "createMarkets")
          for (const p of t.params) emit({ name: "MarketCreated", args: { id: BigInt(store.all().length + 1), gameKey: "0x", ...p } } as never);
        if (t.kind === "lockMarkets") for (const id of t.ids) emit({ name: "MarketLocked", args: { id, lockTime: BigInt(nowSec()) } });
        return {} as never;
      },
    },
    sse: { publish: () => {} },
    requester: { add: () => {} },
    store,
    log: () => {},
  });
  const pipeline = createGamePipeline({ registry: createGameRegistry(), engine, sse: { publish: () => {} }, nowSec, log: () => {} });
  const replayer = createReplayer({
    fetchGame: async () => rapid,
    onUpdate: pipeline.onUpdate,
    newRun: pipeline.newRun,
    sse: { publish: () => {}, viewers: () => 1 },
    engine,
    hasPendingStakes: () => false,
    liveGames: () => 0,
    pool: [],
    startPly: 20, plyIntervalSec: 20, autoIdleMin: 10, requiresViewer: true, viewerGraceSec: 120,
    log: () => {},
    now: () => clockMs,
  });
  const update = async (u: GameUpdate) => { pipeline.onUpdate(u); await pipeline.idle(); };
  const run = async (sec: number) => {
    for (let i = 0; i < sec; i++) { clockMs += 1000; await replayer.tick(); await pipeline.idle(); }
  };
  /** fromPly per batch createMarkets partai itu. */
  const created = (ref: string) => txs.flatMap((t) => (t.kind === "createMarkets" && t.params[0]!.gameRef === ref ? [t.params[0]!.fromPly] : []));
  const locked = () => txs.flatMap((t) => (t.kind === "lockMarkets" ? t.ids : []));
  return { store, pipeline, replayer, update, run, created, locked, txs };
}

test("replay ulang partai yang sama adalah run baru: pasar dibuat lagi sejak ply 20", async () => {
  const w = world();
  await w.replayer.start(rapid.id);
  await w.pipeline.idle();
  await w.run(24 * 20); // sampai selesai
  expect(w.replayer.active()).toBeNull();
  const firstRun = w.created(RAPID).filter((p) => p === 25).length;
  expect(firstRun).toBe(1);

  await w.run(60);
  await w.replayer.start(rapid.id);
  await w.pipeline.idle();
  expect(w.created(RAPID).filter((p) => p === 25)).toHaveLength(2);
});

test("restart resolver tidak menduplikasi pasar partai live yang masih berjalan", async () => {
  const before = world();
  await before.update(bcast(quietSans(28)));
  expect(before.created(BCAST)).toEqual([31]);

  const after = world(before.store); // proses baru, store dibangun ulang dari event chain
  await after.update(bcast(quietSans(28)));
  expect(after.created(BCAST)).toEqual([]);
  await after.update(bcast(quietSans(32)));
  expect(after.created(BCAST)).toEqual([35]);
});

test("update koreksi tetap menjalankan kunci ply (D11)", async () => {
  const w = world();
  await w.update(bcast(quietSans(28)));
  const ids = w.store.byGame(BCAST).map((m) => m.id);
  const fixed: string[] = quietSans(30);
  fixed[9] = "h3"; // koreksi DGT di ply 10, sekaligus ply 30 terlihat
  await w.update(bcast(fixed));
  expect(w.locked()).toEqual(ids);
});

test("partai di-untrack: tetap dikunci, tanpa pasar baru, tidak tampil sebagai partai dilacak", async () => {
  const w = world();
  await w.update(bcast(quietSans(28)));
  const ids = w.store.byGame(BCAST).map((m) => m.id);
  w.pipeline.untrack(BCAST);
  expect(w.pipeline.tracked().map((g) => g.gameRef)).toEqual([]);
  await w.update(bcast(quietSans(30)));
  expect(w.locked()).toEqual(ids);
  await w.update(bcast(quietSans(32)));
  expect(w.created(BCAST)).toEqual([31]);
  w.pipeline.track(BCAST);
  expect(w.pipeline.tracked().map((g) => g.gameRef)).toEqual([BCAST]);
});
