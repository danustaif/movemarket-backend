// Kunci ply (SOT D11): lockMarkets begitu ply fromPly - LOCK_LEAD_PLIES terlihat dan lockTime belum lewat.
import { SOT } from "@movemarket/shared";
import type { LocksDue } from "../contracts.ts";

export const locksDue: LocksDue = (state, markets, nowSec) =>
  markets
    .filter((m) => m.gameRef === state.gameRef && nowSec < m.lockTime && state.sans.length >= m.fromPly - SOT.planner.LOCK_LEAD_PLIES)
    .map((m) => m.id);
