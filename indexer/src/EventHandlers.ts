// Handler Envio untuk LiveMarket. Spesifikasi: source/docs/INDEXER.md bagian 3.
import { LiveMarket } from "generated";
import { Outcome } from "./sot";

LiveMarket.MarketCreated.handler(async ({ event, context }) => {
  const p = event.params;
  const game = await context.Game.get(p.gameKey);
  context.Game.set({
    id: p.gameKey,
    gameRef: p.gameRef,
    marketCount: (game?.marketCount ?? 0) + 1,
    totalVolume: game?.totalVolume ?? 0n,
    firstSeenAt: game?.firstSeenAt ?? BigInt(event.block.timestamp),
  });
  context.Market.set({
    id: p.id.toString(),
    idNum: p.id,
    game_id: p.gameKey,
    gameRef: p.gameRef,
    marketType: Number(p.marketType),
    side: Number(p.side),
    fromPly: Number(p.fromPly),
    toPly: Number(p.toPly),
    lockTime: p.lockTime,
    resolveDeadline: p.resolveDeadline,
    status: "OPEN",
    outcome: Outcome.NONE,
    voidReason: undefined,
    poolYes: 0n,
    poolNo: 0n,
    betCount: 0,
    resolutionRequested: false,
    createdAt: BigInt(event.block.timestamp),
    createdTx: event.transaction.hash,
    resolvedAt: undefined,
    resolvedTx: undefined,
  });
});

const userId = (address: string) => address.toLowerCase();
const positionId = (marketId: bigint, user: string) => `${marketId}-${userId(user)}`;

LiveMarket.BetPlaced.handler(async ({ event, context }) => {
  const p = event.params;
  const ts = BigInt(event.block.timestamp);
  const uid = userId(p.user);
  const market = await context.Market.getOrThrow(p.id.toString());
  // Pool dari nilai event (bukan penjumlahan) supaya tahan reorg dan event terlewat.
  context.Market.set({ ...market, poolYes: p.poolYes, poolNo: p.poolNo, betCount: market.betCount + 1 });

  const game = await context.Game.getOrThrow(market.game_id);
  context.Game.set({ ...game, totalVolume: game.totalVolume + p.amount });

  context.Bet.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    market_id: market.id,
    user_id: uid,
    yes: p.yes,
    amount: p.amount,
    timestamp: ts,
    txHash: event.transaction.hash,
  });

  const pid = positionId(p.id, p.user);
  const pos = (await context.Position.get(pid)) ?? {
    id: pid, market_id: market.id, user_id: uid, stakeYes: 0n, stakeNo: 0n, payout: 0n, settled: false, createdAt: ts,
  };
  context.Position.set(
    p.yes ? { ...pos, stakeYes: pos.stakeYes + p.amount } : { ...pos, stakeNo: pos.stakeNo + p.amount },
  );

  const user = (await context.User.get(uid)) ?? {
    id: uid, totalStaked: 0n, totalPayout: 0n, netProfit: 0n, betCount: 0, winCount: 0, firstSeenAt: ts,
  };
  context.User.set({ ...user, totalStaked: user.totalStaked + p.amount, betCount: user.betCount + 1 });
});

LiveMarket.MarketLocked.handler(async ({ event, context }) => {
  const market = await context.Market.getOrThrow(event.params.id.toString());
  context.Market.set({ ...market, lockTime: event.params.lockTime });
});

LiveMarket.ResolutionRequested.handler(async ({ event, context }) => {
  for (const id of event.params.ids) {
    const market = await context.Market.get(id.toString());
    if (market) context.Market.set({ ...market, resolutionRequested: true });
  }
});

LiveMarket.MarketResolved.handler(async ({ event, context }) => {
  const market = await context.Market.getOrThrow(event.params.id.toString());
  context.Market.set({
    ...market,
    status: "RESOLVED",
    outcome: Number(event.params.outcome),
    resolvedAt: BigInt(event.block.timestamp),
    resolvedTx: event.transaction.hash,
  });
});

LiveMarket.Claimed.handler(async ({ event, context }) => {
  const { id, user, payout } = event.params;
  const market = await context.Market.getOrThrow(id.toString());
  const pos = await context.Position.getOrThrow(positionId(id, user));
  context.Position.set({ ...pos, payout, settled: true });
  const winStake = market.outcome === Outcome.YES ? pos.stakeYes : pos.stakeNo;
  const u = await context.User.getOrThrow(userId(user));
  context.User.set({
    ...u,
    totalPayout: u.totalPayout + payout,
    netProfit: u.netProfit + payout - winStake,
    winCount: u.winCount + 1,
  });
});

LiveMarket.MarketVoided.handler(async ({ event, context }) => {
  const market = await context.Market.getOrThrow(event.params.id.toString());
  context.Market.set({ ...market, status: "VOIDED", outcome: Outcome.VOID, voidReason: Number(event.params.reason) });
});

LiveMarket.Refunded.handler(async ({ event, context }) => {
  const { id, user, amount } = event.params;
  const pos = await context.Position.getOrThrow(positionId(id, user));
  context.Position.set({ ...pos, payout: amount, settled: true });
  const u = await context.User.getOrThrow(userId(user));
  context.User.set({ ...u, totalPayout: u.totalPayout + amount });
});
