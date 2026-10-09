import type { GameState, TrackedMarket } from "../src/contracts.ts";

export const FIXTURES = new URL("../../../source/sot/fixtures/lichess/", import.meta.url);
export const fixture = (file: string) => Bun.file(new URL(file, FIXTURES)).text();

/** sans dummy sepanjang n ply tanpa skak, makan, atau rokade. */
export const quietSans = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? "Nf6" : "Nf3"));

export function gameState(p: Partial<GameState> = {}): GameState {
  return {
    gameRef: "lichess:game:e9SJcXpJ", source: "replay", speed: "classical",
    white: { name: "W" }, black: { name: "B" }, sans: quietSans(28), ended: false, isReplay: true,
    fen: "", castled: { white: false, black: false }, updatedAt: 0, ...p,
  };
}

export function market(p: Partial<TrackedMarket> = {}): TrackedMarket {
  return {
    id: 1n, gameRef: "lichess:game:e9SJcXpJ", marketType: 0, side: 0, fromPly: 31, toPly: 34,
    lockTime: 1_000, resolveDeadline: 22_600, poolYes: 0n, poolNo: 0n, provisional: "PENDING",
    requested: false, final: null, voidReason: null, ...p,
  };
}
