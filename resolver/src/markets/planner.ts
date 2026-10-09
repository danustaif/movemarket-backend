// Perencana pasar (docs/RESOLUTION_SPEC.md bagian 9). Murni: waktu masuk lewat nowSec.
import { MARKET_TYPE, SIDE, SOT } from "@movemarket/shared";
import type { MarketParams, PlanMarkets } from "../contracts.ts";

const P = SOT.planner;
const SUPPORTED: readonly string[] = SOT.speed.supported;

export const planMarkets: PlanMarkets = (state, markets, nowSec) => {
  const ply = state.sans.length;
  if (ply === 0 || ply % P.SPAWN_EVERY_PLIES !== 0 || state.ended || !SUPPORTED.includes(state.speed)) return [];

  const plyGap = P.PLY_GAP[state.speed as keyof typeof P.PLY_GAP];
  const fromPly = ply + plyGap + 1;
  const own = markets.filter((m) => m.gameRef === state.gameRef);
  if (own.some((m) => m.fromPly === fromPly)) return [];
  const room = P.MAX_OPEN_MARKETS_PER_GAME - own.filter((m) => m.lockTime > nowSec).length;
  if (room <= 0) return [];

  const lockTime = BigInt(nowSec + P.BET_WINDOW_SEC);
  const base = { gameRef: state.gameRef, fromPly, lockTime, resolveDeadline: lockTime + BigInt(P.RESOLVE_DEADLINE_SEC) };
  const window = fromPly + P.WINDOW_PLIES - 1;
  const castleWindow = fromPly + P.CASTLE_WINDOW_PLIES - 1;
  const out: MarketParams[] = [
    { ...base, marketType: MARKET_TYPE.CHECK, side: SIDE.ANY, toPly: window },
    { ...base, marketType: MARKET_TYPE.CAPTURE, side: SIDE.ANY, toPly: window },
  ];
  if (ply < P.CASTLE_MAX_CURRENT_PLY) {
    if (!state.castled.white) out.push({ ...base, marketType: MARKET_TYPE.CASTLE, side: SIDE.WHITE, toPly: castleWindow });
    if (!state.castled.black) out.push({ ...base, marketType: MARKET_TYPE.CASTLE, side: SIDE.BLACK, toPly: castleWindow });
  }
  // Batch dipotong supaya total pasar terbuka tidak melewati MAX_OPEN_MARKETS_PER_GAME.
  return out.slice(0, room);
};
