import { beforeEach, expect, test } from "bun:test";
import { SOT } from "@movemarket/shared";
import type { ResolverTx, TrackedMarket } from "../src/contracts.ts";
import { createMarketEngine } from "../src/markets/engine.ts";
import { gameState, market, quietSans } from "./helpers.ts";

const NOW = 1_000;
let calls: string[];
let added: bigint[];
let markets: Map<bigint, TrackedMarket>;
const store = {
  byGame: (ref: string) => [...markets.values()].filter((m) => m.gameRef === ref),
  setProvisional: (id: bigint, o: TrackedMarket["provisional"]) => void (markets.get(id)!.provisional = o),
  get: (id: bigint) => markets.get(id),
};
let failLock: boolean;

const put = (m: TrackedMarket) => markets.set(m.id, m);

const engine = () =>
  createMarketEngine({
    tx: { send: async (t: ResolverTx) => { calls.push(`tx:${t.kind}`); if (t.kind === "lockMarkets" && failLock) throw new Error("x"); return {} as never; } },
    sse: { publish: (e, data) => void calls.push(`sse:${e}:${JSON.stringify(data)}`) },
    requester: { add: (_ref, ids) => void added.push(...ids) },
    store,
    log: (e) => void calls.push(`log:${e}`),
  });

beforeEach(() => {
  calls = []; added = []; failLock = false;
  markets = new Map();
});

test("urutan per ply: kunci -> sementara -> rencana", async () => {
  put(market({ id: 1n, fromPly: 29, toPly: 32, lockTime: NOW + 5 }));                // dikunci di ply 28
  put(market({ id: 2n, fromPly: 25, toPly: 26, lockTime: NOW - 1, poolYes: 1n }));    // ply 25-26 sepi -> NO
  await engine().onPly(gameState({ sans: quietSans(28) }), NOW);
  expect(calls).toEqual([
    "tx:lockMarkets",
    `sse:market_locked:{"gameRef":"lichess:game:e9SJcXpJ","marketIds":["1"],"lockTime":${NOW}}`,
    `sse:provisional:{"gameRef":"lichess:game:e9SJcXpJ","marketId":"2","outcome":"NO"}`,
    "tx:createMarkets",
  ]);
  expect(store.get(2n)!.provisional).toBe("NO");
  expect(added).toEqual([2n]);
});

test("kunci tidak dikirim dua kali sebelum MarketLocked masuk store; dicoba ulang kalau gagal", async () => {
  put(market({ id: 1n, fromPly: 31, lockTime: NOW + 5 }));
  const e = engine();
  failLock = true;
  await e.onPly(gameState({ sans: quietSans(30) }), NOW);
  expect(calls).toEqual(["tx:lockMarkets", "log:lock_failed"]);
  failLock = false;
  calls = [];
  await e.onPly(gameState({ sans: quietSans(31) }), NOW);
  await e.onPly(gameState({ sans: quietSans(31) }), NOW);
  expect(calls.filter((c) => c === "tx:lockMarkets")).toHaveLength(1);
});

test("setSpawning(false) menghentikan pasar baru tapi tetap mengunci; ply yang sama tidak spawn dua kali", async () => {
  const e = engine();
  e.setSpawning("lichess:game:e9SJcXpJ", false);
  put(market({ id: 1n, fromPly: 29, lockTime: NOW + 5 }));
  await e.onPly(gameState({ sans: quietSans(28) }), NOW);
  expect(calls).not.toContain("tx:createMarkets");
  expect(calls).toContain("tx:lockMarkets");
  e.setSpawning("lichess:game:e9SJcXpJ", true);
  calls = [];
  await e.onPly(gameState({ sans: quietSans(32) }), NOW);
  await e.onPly(gameState({ sans: quietSans(32), ended: false }), NOW);
  expect(calls.filter((c) => c === "tx:createMarkets")).toHaveLength(1);
});

test("koreksi menghitung ulang semua pasar belum final, termasuk yang sudah di-request", async () => {
  put(market({ id: 1n, fromPly: 1, toPly: 2, provisional: "NO", requested: true, poolNo: 1n }));
  put(market({ id: 2n, fromPly: 1, toPly: 2, provisional: "NO", final: "NO" }));
  await engine().onCorrection(gameState({ sans: ["e4", "Bb4+"] }), NOW);
  expect(store.get(1n)!.provisional).toBe("YES");
  expect(store.get(2n)!.provisional).toBe("NO");
  expect(calls).toEqual([`sse:provisional:{"gameRef":"lichess:game:e9SJcXpJ","marketId":"1","outcome":"YES"}`]);
});

test("setSpawning per partai: replay tanpa penonton tidak menghentikan pasar broadcast live (D16)", async () => {
  const e = engine();
  e.setSpawning("lichess:game:e9SJcXpJ", false);
  await e.onPly(gameState({ gameRef: "lichess:study:cbVdruwJ:fGXnnaOp", source: "broadcast", isReplay: false }), NOW);
  expect(calls).toContain("tx:createMarkets");
});

test("marketsOf: replay ulang partai yang sama hanya menampilkan pasar run sekarang (plus run lama yang masih menunggu hasil dengan stake)", () => {
  const { BET_WINDOW_SEC, RESOLVE_DEADLINE_SEC } = SOT.planner;
  const madeAt = (t: number) => ({ lockTime: t + BET_WINDOW_SEC, resolveDeadline: t + BET_WINDOW_SEC + RESOLVE_DEADLINE_SEC });
  put(market({ id: 9n, fromPly: 25, ...madeAt(100) }));                                 // run lama, tanpa stake
  put(market({ id: 13n, fromPly: 25, ...madeAt(200), final: "NO", poolNo: 1n }));      // run lama, sudah final
  put(market({ id: 15n, fromPly: 29, ...madeAt(210), poolYes: 1n }));                  // run lama, stake menunggu hasil
  put(market({ id: 66n, fromPly: 25, ...madeAt(NOW + 10) }));                          // run sekarang
  const e = engine();
  expect(e.marketsOf("lichess:game:e9SJcXpJ").map((m) => m.id)).toEqual([9n, 13n, 15n, 66n]); // tanpa newRun: semua
  e.newRun("lichess:game:e9SJcXpJ", NOW);
  expect(e.marketsOf("lichess:game:e9SJcXpJ").map((m) => m.id)).toEqual([15n, 66n]);
});
