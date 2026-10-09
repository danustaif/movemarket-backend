import { expect, test } from "bun:test";
import { parseLichessJson, parsePgn, type MarketSpec } from "@movemarket/shared";
import vectors from "../../../source/sot/test-vectors.json";
import { provisionalChanges } from "../src/markets/provisional.ts";
import { fixture, gameState, market } from "./helpers.ts";

test("hasil sementara cocok dengan semua vektor resolusi sot", async () => {
  for (const v of vectors.resolution) {
    const g = v.game as { source: string; plies?: number; ended?: boolean; file?: string; kind?: string };
    const snap = g.source === "BASE"
      ? { sans: vectors.base.BASE.slice(0, g.plies), ended: g.ended! }
      : g.kind === "json" ? parseLichessJson(JSON.parse(await fixture(g.file!))) : parsePgn(await fixture(g.file!));
    const got = provisionalChanges(gameState(snap), [market({ id: 1n, ...(v.market as MarketSpec) })]);
    expect<unknown>([v.id, got]).toEqual([v.id, v.expected === "PENDING" ? [] : [{ id: 1n, outcome: v.expected }]]);
  }
});

test("hanya mengembalikan pasar yang hasilnya berubah (termasuk kembali ke PENDING setelah koreksi)", () => {
  const s = gameState({ sans: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"] });
  const spec = { marketType: 0, side: 0, fromPly: 1, toPly: 4 } as const;
  expect(provisionalChanges(s, [market({ ...spec, provisional: "NO" })])).toEqual([]);
  expect(provisionalChanges(gameState({ sans: ["e4"] }), [market({ ...spec, provisional: "NO" })]))
    .toEqual([{ id: 1n, outcome: "PENDING" }]);
});
