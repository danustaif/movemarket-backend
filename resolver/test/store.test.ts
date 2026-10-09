import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import type { LiveMarketEvent } from "../src/contracts.ts";
import { MemoryMarketStore } from "../src/markets/store.ts";

const ALICE = "0x00000000000000000000000000000000000000A1" as Address;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ev = (e: { name: string; args: object }, n = 1): LiveMarketEvent => ({ ...e, txHash: tx(n), blockNumber: 1n }) as LiveMarketEvent;
const ref = "lichess:game:e9SJcXpJ";
const created = (id: bigint, n = 1) => ev({ name: "MarketCreated", args: {
  id, gameKey: tx(99), gameRef: ref, marketType: 1, side: 0, fromPly: 31, toPly: 34, lockTime: 1015n, resolveDeadline: 22615n,
} }, n);

test("membangun state pasar dari event", () => {
  const s = new MemoryMarketStore(async () => 0n);
  s.apply(created(3n));
  expect(s.get(3n)).toMatchObject({ id: 3n, gameRef: ref, marketType: 1, side: 0, fromPly: 31, toPly: 34, lockTime: 1015, resolveDeadline: 22615, provisional: "PENDING", requested: false, final: null });
  s.apply(ev({ name: "MarketLocked", args: { id: 3n, lockTime: 1003n } }, 2));
  s.apply(ev({ name: "BetPlaced", args: { id: 3n, user: ALICE, yes: true, amount: 5_000_000n, poolYes: 5_000_000n, poolNo: 0n } }, 3));
  s.apply(ev({ name: "ResolutionRequested", args: { gameKey: tx(99), gameRef: ref, ids: [3n] } }, 4));
  expect(s.get(3n)).toMatchObject({ lockTime: 1003, poolYes: 5_000_000n, poolNo: 0n, requested: true });
  s.apply(ev({ name: "MarketResolved", args: { id: 3n, outcome: 2 } }, 5));
  expect(s.get(3n)).toMatchObject({ final: "NO", voidReason: null });
  s.apply(created(4n, 6));
  s.apply(ev({ name: "MarketVoided", args: { id: 4n, reason: 2 } }, 7));
  expect(s.get(4n)).toMatchObject({ final: "VOID", voidReason: 2 });
  expect(s.byGame(ref).map((m) => m.id)).toEqual([3n, 4n]);
});

test("posisi per alamat, claimable dibaca lewat fungsi injeksi, event ganda (proposed+finalized) tidak dihitung dua kali", async () => {
  const reads: bigint[] = [];
  const s = new MemoryMarketStore(async (id, user) => (reads.push(id), user.toLowerCase() === ALICE.toLowerCase() ? 9_800_000n : 0n));
  s.apply(created(3n));
  s.apply(created(5n, 2));
  const bet = (id: bigint, yes: boolean, amount: bigint, n: number) =>
    ev({ name: "BetPlaced", args: { id, user: ALICE, yes, amount, poolYes: 0n, poolNo: 0n } }, n);
  for (const e of [bet(3n, true, 5_000_000n, 3), bet(3n, true, 5_000_000n, 3), bet(3n, false, 1_000_000n, 4), bet(5n, true, 1_000_000n, 5)]) s.apply(e);
  s.apply(ev({ name: "MarketResolved", args: { id: 3n, outcome: 1 } }, 6));

  const pos = await s.positions(ALICE.toLowerCase() as Address);
  expect(pos).toEqual([
    { marketId: "3", gameRef: ref, stakeYes: "5000000", stakeNo: "1000000", status: 1, outcome: 1, resolveDeadline: 22615, settled: false, claimable: "9800000", voidReason: null },
    { marketId: "5", gameRef: ref, stakeYes: "1000000", stakeNo: "0", status: 0, outcome: 0, resolveDeadline: 22615, settled: false, claimable: "0", voidReason: null },
  ]);
  expect(reads).toEqual([3n]); // pasar belum final tidak dibaca

  s.apply(ev({ name: "Claimed", args: { id: 3n, user: ALICE, payout: 9_800_000n } }, 7));
  expect((await s.positions(ALICE))[0]).toMatchObject({ settled: true, claimable: "0" });
});

test("posisi pasar VOID membawa alasan void (NO_WINNERS) untuk label /me", async () => {
  const s = new MemoryMarketStore(async () => 0n);
  s.apply(created(4n));
  s.apply(ev({ name: "BetPlaced", args: { id: 4n, user: ALICE, yes: true, amount: 1_000_000n, poolYes: 1_000_000n, poolNo: 0n } }, 2));
  s.apply(ev({ name: "MarketVoided", args: { id: 4n, reason: 2 } }, 3));
  expect((await s.positions(ALICE))[0]).toMatchObject({ status: 2, outcome: 3, voidReason: 2 });
});

test("setProvisional menyimpan hasil sementara", () => {
  const s = new MemoryMarketStore(async () => 0n);
  s.apply(created(3n));
  s.setProvisional(3n, "YES");
  expect(s.get(3n)!.provisional).toBe("YES");
});
