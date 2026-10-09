import { describe, expect, it } from "vitest";
import { createTestIndexer } from "generated";

const CHAIN = 10143;
const GAME_KEY = "0x" + "ab".repeat(32);
const GAME_REF = "lichess:e9SJcXpJ";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";

const B = 69_650_000;
const created = (id: bigint, block = B) => ({
  contract: "LiveMarket" as const,
  event: "MarketCreated" as const,
  block: { number: block, timestamp: 1_000 },
  transaction: { hash: `0xc${id}` },
  params: {
    id, gameKey: GAME_KEY, gameRef: GAME_REF, marketType: 0n, side: 1n,
    fromPly: 31n, toPly: 34n, lockTime: 2_000n, resolveDeadline: 9_000n,
  },
});

async function run(...simulate: any[]) {
  const indexer = createTestIndexer();
  await indexer.process({ chains: { [CHAIN]: { simulate } } });
  return indexer;
}

describe("MarketCreated", () => {
  it("membuat Game dan Market OPEN dengan idNum", async () => {
    const ix = await run(created(1n), created(2n, B + 1));
    expect(await ix.Game.getOrThrow(GAME_KEY)).toEqual({
      id: GAME_KEY, gameRef: GAME_REF, marketCount: 2, totalVolume: 0n, firstSeenAt: 1_000n,
    });
    expect(await ix.Market.getOrThrow("1")).toEqual({
      id: "1", idNum: 1n, game_id: GAME_KEY, gameRef: GAME_REF, marketType: 0, side: 1,
      fromPly: 31, toPly: 34, lockTime: 2_000n, resolveDeadline: 9_000n,
      status: "OPEN", outcome: 0, voidReason: undefined, poolYes: 0n, poolNo: 0n, betCount: 0,
      resolutionRequested: false, createdAt: 1_000n, createdTx: "0xc1",
      resolvedAt: undefined, resolvedTx: undefined,
    });
  });
});

const bet = (id: bigint, user: string, yes: boolean, amount: bigint, poolYes: bigint, poolNo: bigint, ts = 1_100) => ({
  contract: "LiveMarket" as const,
  event: "BetPlaced" as const,
  block: { number: B + 10, timestamp: ts },
  transaction: { hash: "0xbe7" },
  params: { id, user, yes, amount, poolYes, poolNo },
});
const alice = ALICE.toLowerCase();
const bob = BOB.toLowerCase();

describe("BetPlaced", () => {
  it("pool dari event, posisi dua sisi per user, statistik user dan game", async () => {
    const ix = await run(
      created(1n),
      bet(1n, ALICE, true, 5_000_000n, 5_000_000n, 0n),
      bet(1n, BOB, false, 3_000_000n, 5_000_000n, 3_000_000n, 1_200),
      bet(1n, ALICE, false, 1_000_000n, 5_000_000n, 4_000_000n, 1_300),
    );
    const m = await ix.Market.getOrThrow("1");
    expect([m.poolYes, m.poolNo, m.betCount]).toEqual([5_000_000n, 4_000_000n, 3]);
    expect(await ix.Position.getOrThrow(`1-${alice}`)).toEqual({
      id: `1-${alice}`, market_id: "1", user_id: alice, stakeYes: 5_000_000n, stakeNo: 1_000_000n,
      payout: 0n, settled: false, createdAt: 1_100n,
    });
    expect(await ix.User.getOrThrow(alice)).toEqual({
      id: alice, totalStaked: 6_000_000n, totalPayout: 0n, netProfit: 0n, betCount: 2, winCount: 0, firstSeenAt: 1_100n,
    });
    expect((await ix.User.getOrThrow(bob)).totalStaked).toBe(3_000_000n);
    expect((await ix.Game.getOrThrow(GAME_KEY)).totalVolume).toBe(9_000_000n);
    const bets = await ix.Bet.getAll();
    expect(bets).toHaveLength(3);
    expect(bets.find((b) => b.user_id === bob)).toMatchObject({ market_id: "1", yes: false, amount: 3_000_000n, timestamp: 1_200n, txHash: "0xbe7" });
  });
});

const ev = <E extends string>(event: E, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  contract: "LiveMarket" as const, event, block: { number: B + 20, timestamp: 1_500 }, transaction: { hash: "0xee" }, params, ...extra,
});

describe("MarketLocked", () => {
  it("lockTime diganti nilai event", async () => {
    const ix = await run(created(1n), ev("MarketLocked", { id: 1n, lockTime: 1_400n }));
    expect((await ix.Market.getOrThrow("1")).lockTime).toBe(1_400n);
  });
});

describe("ResolutionRequested", () => {
  it("menandai setiap id di event, pasar lain tidak tersentuh", async () => {
    const ix = await run(created(1n), created(2n), created(3n),
      ev("ResolutionRequested", { gameKey: GAME_KEY, gameRef: GAME_REF, ids: [1n, 3n] }));
    const flags = await Promise.all(["1", "2", "3"].map(async (id) => (await ix.Market.getOrThrow(id)).resolutionRequested));
    expect(flags).toEqual([true, false, true]);
  });
});

describe("MarketResolved + Claimed", () => {
  it("status RESOLVED, klaim mencatat payout dan netProfit = payout - stake sisi menang", async () => {
    const ix = await run(
      created(1n),
      bet(1n, ALICE, true, 5_000_000n, 5_000_000n, 0n),
      bet(1n, BOB, false, 3_000_000n, 5_000_000n, 3_000_000n),
      bet(1n, ALICE, false, 1_000_000n, 5_000_000n, 4_000_000n),
      ev("MarketResolved", { id: 1n, outcome: 1n }),
      ev("Claimed", { id: 1n, user: ALICE, payout: 8_820_000n }, { block: { number: B + 30, timestamp: 1_600 } }),
    );
    expect(await ix.Market.getOrThrow("1")).toMatchObject({ status: "RESOLVED", outcome: 1, resolvedAt: 1_500n, resolvedTx: "0xee" });
    expect(await ix.Position.getOrThrow(`1-${alice}`)).toMatchObject({ payout: 8_820_000n, settled: true });
    expect(await ix.User.getOrThrow(alice)).toMatchObject({ totalPayout: 8_820_000n, netProfit: 3_820_000n, winCount: 1 });
    expect(await ix.User.getOrThrow(bob)).toMatchObject({ totalPayout: 0n, netProfit: 0n, winCount: 0 });
  });

  it("outcome NO memakai stakeNo", async () => {
    const ix = await run(
      created(1n),
      bet(1n, ALICE, true, 5_000_000n, 5_000_000n, 0n),
      bet(1n, BOB, false, 3_000_000n, 5_000_000n, 3_000_000n),
      ev("MarketResolved", { id: 1n, outcome: 2n }),
      ev("Claimed", { id: 1n, user: BOB, payout: 7_840_000n }, { block: { number: B + 30, timestamp: 1_600 } }),
    );
    expect(await ix.User.getOrThrow(bob)).toMatchObject({ netProfit: 4_840_000n, winCount: 1 });
  });
});

describe("MarketVoided + Refunded", () => {
  it("status VOIDED, outcome VOID (3), voidReason; refund menambah totalPayout tanpa mengubah netProfit", async () => {
    const ix = await run(
      created(8n),
      bet(8n, ALICE, true, 5_000_000n, 5_000_000n, 0n),
      bet(8n, ALICE, false, 1_000_000n, 5_000_000n, 1_000_000n),
      ev("MarketVoided", { id: 8n, reason: 3n }),
      ev("Refunded", { id: 8n, user: ALICE, amount: 6_000_000n }, { block: { number: B + 30, timestamp: 1_600 } }),
    );
    expect(await ix.Market.getOrThrow("8")).toMatchObject({ status: "VOIDED", outcome: 3, voidReason: 3 });
    expect(await ix.Position.getOrThrow(`8-${alice}`)).toMatchObject({ payout: 6_000_000n, settled: true });
    expect(await ix.User.getOrThrow(alice)).toMatchObject({ totalPayout: 6_000_000n, netProfit: 0n, winCount: 0 });
  });
});
