import { expect, test } from "bun:test";
import { locksDue } from "../src/markets/locker.ts";
import { gameState, market, quietSans } from "./helpers.ts";

const NOW = 1_000;
const m = market({ id: 7n, fromPly: 31, lockTime: NOW + 10 });

test("dikunci tepat saat ply fromPly - LOCK_LEAD_PLIES (30) terlihat, tidak sebelumnya", () => {
  expect(locksDue(gameState({ sans: quietSans(29) }), [m], NOW)).toEqual([]);
  expect(locksDue(gameState({ sans: quietSans(30) }), [m], NOW)).toEqual([7n]);
  expect(locksDue(gameState({ sans: quietSans(33) }), [m], NOW)).toEqual([7n]);
});

test("tidak dikunci dua kali: setelah MarketLocked lockTime <= now", () => {
  expect(locksDue(gameState({ sans: quietSans(31) }), [{ ...m, lockTime: NOW }], NOW)).toEqual([]);
});

test("hanya pasar partai ini", () => {
  expect(locksDue(gameState({ sans: quietSans(30) }), [{ ...m, gameRef: "lichess:game:AAAAAAAA" }], NOW)).toEqual([]);
});
