import { beforeEach, expect, test } from "bun:test";
import type { Snapshot } from "@movemarket/shared";
import type { ResolverTx, TrackedMarket } from "../src/contracts.ts";
import { createRequester, type RequesterDeps } from "../src/markets/requester.ts";
import { market, quietSans } from "./helpers.ts";

const REF = "lichess:game:e9SJcXpJ";
let now: number;
let sent: { gameRef: string; ids: bigint[] }[];
let logs: string[];
let markets: Map<bigint, TrackedMarket>;
let exportSnap: Snapshot;
let open: Set<bigint>;

const setup = (over: Partial<RequesterDeps> = {}) =>
  createRequester({
    tx: { send: async (t: ResolverTx) => { if (t.kind === "requestResolution") sent.push({ gameRef: t.gameRef, ids: t.ids }); return {} as never; } },
    market: (id) => markets.get(id),
    fetchExport: async () => exportSnap,
    openIds: async (ids) => ids.filter((id) => open.has(id)),
    nowSec: () => now,
    log: (event) => void logs.push(event),
    ...over,
  });

/** n pasar CHECK ANY ply 1-4 dengan stake; sans sepi -> NO. */
const seed = (n: number, p: Partial<TrackedMarket> = {}) => {
  for (let i = 1; i <= n; i++)
    markets.set(BigInt(i), market({ id: BigInt(i), fromPly: 1, toPly: 4, provisional: "NO", poolYes: 1_000_000n, ...p }));
  return Array.from({ length: n }, (_, i) => BigInt(i + 1));
};

beforeEach(() => {
  now = 1_000; sent = []; logs = []; markets = new Map(); open = new Set();
  exportSnap = { sans: quietSans(10), ended: false };
});

test("batch maksimal 8 id per requestResolution", async () => {
  const r = setup();
  r.add(REF, seed(7));
  await r.flush();
  expect(sent.map((s) => s.ids.length)).toEqual([7]);
  sent = [];
  const ids = seed(18).slice(7);
  r.add(REF, ids.slice(0, 3));
  r.add(REF, ids.slice(3));
  await r.flush();
  expect(sent.map((s) => s.ids.length)).toEqual([8, 3]);
});

test("antrian partai yang mencapai 8 langsung di-flush tanpa menunggu interval", async () => {
  const r = setup();
  r.add(REF, seed(8));
  await Bun.sleep(0);
  expect(sent.map((s) => s.ids.length)).toEqual([8]);
});

test("prasyarat export: tunggu selama PENDING, tahan kalau beda, kirim kalau sama", async () => {
  const r = setup();
  seed(2);
  markets.get(2n)!.provisional = "YES";
  exportSnap = { sans: quietSans(2), ended: false }; // ply 1-4 belum lengkap -> PENDING
  r.add(REF, [1n, 2n]);
  await r.flush();
  expect(sent).toEqual([]);
  exportSnap = { sans: quietSans(10), ended: false };
  await r.flush();
  await r.flush();
  expect(sent).toEqual([{ gameRef: REF, ids: [1n] }]);
  expect(logs.filter((l) => l === "mismatch_pre")).toHaveLength(1);
  markets.get(2n)!.provisional = "NO"; // misal setelah koreksi
  await r.flush();
  expect(sent[1]).toEqual({ gameRef: REF, ids: [2n] });
});

test("pasar tanpa stake tidak pernah di-request (D18)", async () => {
  const r = setup();
  r.add(REF, seed(1, { poolYes: 0n, poolNo: 0n }));
  await r.flush();
  await r.flush();
  expect(sent).toEqual([]);
});

test("retry hanya id OPEN setelah FINAL_WAIT_SEC + backoff, lalu cre_failed setelah MAX_RETRIES", async () => {
  const r = setup();
  r.add(REF, seed(3));
  await r.flush();
  open = new Set([1n, 2n]); // 3 sudah final di chain
  r.settled(2n);           // 2 sudah terlihat MarketResolved
  now += 120 + 29;
  await r.flush();
  expect(sent).toHaveLength(1);
  now += 1; // 120 + 30
  await r.flush();
  expect(sent[1]).toEqual({ gameRef: REF, ids: [1n] });
  now += 120 + 60; await r.flush();
  now += 120 + 120; await r.flush();
  expect(sent.map((s) => s.ids)).toEqual([[1n, 2n, 3n], [1n], [1n], [1n]]);
  now += 120; await r.flush();
  expect(logs).toContain("cre_failed");
  now += 10_000; await r.flush();
  expect(sent).toHaveLength(4);
});

test("retry yang gagal menunggu jadwal berikutnya, tidak diulang tiap flush", async () => {
  let attempts = 0;
  let fail = false;
  const r = setup({
    tx: { send: async () => { attempts++; if (fail) throw new Error("rpc down"); return {} as never; } },
    openIds: async (ids) => ids,
  });
  r.add(REF, seed(1));
  await r.flush();
  expect(attempts).toBe(1);
  fail = true;
  now += 120 + 30; await r.flush(); // retry 1 gagal
  expect(attempts).toBe(2);
  now += 3; await r.flush();
  now += 3; await r.flush();
  expect(attempts).toBe(2);
  fail = false;
  now += 120 + 60; await r.flush(); // jadwal retry 2 dihitung dari retry 1 yang gagal
  expect(attempts).toBe(3);
});

test("maxBatch dari config (REQUEST_MAX_BATCH) menggantikan default SOT", async () => {
  const r = setup({ maxBatch: 3 });
  r.add(REF, seed(7));
  await r.flush();
  expect(sent.map((s) => s.ids.length)).toEqual([3, 3, 1]);
});

test("cre_failed ditandai untuk operator dengan gameRef dan waktu; hilang setelah settled", async () => {
  const r = setup();
  r.add(REF, seed(1));
  open = new Set([1n]);
  await r.flush();
  for (const wait of [150, 180, 240, 120]) { now += wait; await r.flush(); }
  expect(r.failed()).toEqual([{ id: 1n, gameRef: REF, at: now }]);
  r.settled(1n); // misal adminVoid oleh operator
  expect(r.failed()).toEqual([]);
});
