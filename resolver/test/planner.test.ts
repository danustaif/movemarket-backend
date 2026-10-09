import { describe, expect, test } from "bun:test";
import { planMarkets } from "../src/markets/planner.ts";
import { gameState, market, quietSans } from "./helpers.ts";

const NOW = 1_000;
const ref = "lichess:game:e9SJcXpJ";

describe("planMarkets", () => {
  test("classical di ply 28: CHECK/CAPTURE ply 31-34, CASTLE per sisi 31-38, waktu dari SOT", () => {
    const out = planMarkets(gameState({ sans: quietSans(28) }), [], NOW);
    expect(out).toEqual([
      { gameRef: ref, marketType: 0, side: 0, fromPly: 31, toPly: 34, lockTime: 1015n, resolveDeadline: 22615n },
      { gameRef: ref, marketType: 1, side: 0, fromPly: 31, toPly: 34, lockTime: 1015n, resolveDeadline: 22615n },
      { gameRef: ref, marketType: 2, side: 1, fromPly: 31, toPly: 38, lockTime: 1015n, resolveDeadline: 22615n },
      { gameRef: ref, marketType: 2, side: 2, fromPly: 31, toPly: 38, lockTime: 1015n, resolveDeadline: 22615n },
    ]);
  });

  test("rapid memakai plyGap 4", () => {
    const out = planMarkets(gameState({ speed: "rapid", sans: quietSans(28) }), [], NOW);
    expect(out[0]).toMatchObject({ fromPly: 33, toPly: 36 });
  });

  test("tidak spawn di luar kelipatan 4, ply 0, blitz/bullet/unknown, atau partai selesai", () => {
    expect(planMarkets(gameState({ sans: quietSans(29) }), [], NOW)).toEqual([]);
    expect(planMarkets(gameState({ sans: [] }), [], NOW)).toEqual([]);
    for (const speed of ["blitz", "bullet", "unknown"] as const)
      expect(planMarkets(gameState({ speed }), [], NOW)).toEqual([]);
    expect(planMarkets(gameState({ ended: true }), [], NOW)).toEqual([]);
  });

  test("CASTLE hanya untuk sisi yang belum rokade dan currentPly < 40", () => {
    const sides = (s: ReturnType<typeof planMarkets>) => s.filter((m) => m.marketType === 2).map((m) => m.side);
    expect(sides(planMarkets(gameState({ castled: { white: true, black: false } }), [], NOW))).toEqual([2]);
    expect(sides(planMarkets(gameState({ sans: quietSans(36) }), [], NOW))).toEqual([1, 2]);
    expect(sides(planMarkets(gameState({ sans: quietSans(40) }), [], NOW))).toEqual([]);
  });

  test("batas 12 pasar terbuka per partai; pasar terkunci dan partai lain tidak dihitung", () => {
    const open = (n: number) => Array.from({ length: n }, (_, i) => market({ id: BigInt(i), fromPly: 10, lockTime: NOW + 1 }));
    expect(planMarkets(gameState(), open(12), NOW)).toEqual([]);
    expect(planMarkets(gameState(), open(10), NOW)).toHaveLength(2);
    const lockedOrOther = [
      ...Array.from({ length: 12 }, (_, i) => market({ id: BigInt(i), fromPly: 10, lockTime: NOW })),
      ...Array.from({ length: 12 }, (_, i) => market({ id: BigInt(100 + i), fromPly: 10, gameRef: "lichess:game:AAAAAAAA", lockTime: NOW + 9 })),
    ];
    expect(planMarkets(gameState(), lockedOrOther, NOW)).toHaveLength(4);
  });

  test("tidak membuat ulang pasar dengan fromPly yang sama (misal setelah restart atau koreksi)", () => {
    expect(planMarkets(gameState(), [market({ fromPly: 31, lockTime: 0 })], NOW)).toEqual([]);
  });

  test("pasar tidak pernah untuk ply berikutnya: fromPly > currentPly + plyGap", () => {
    for (let ply = 4; ply < 120; ply += 4)
      for (const speed of ["classical", "rapid"] as const)
        for (const m of planMarkets(gameState({ speed, sans: quietSans(ply) }), [], NOW))
          expect(m.fromPly).toBeGreaterThan(ply + (speed === "classical" ? 2 : 4));
  });
});
