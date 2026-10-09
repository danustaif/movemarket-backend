import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Outcome } from "../src/sot";
// Butuh clone source/ berdampingan (source/CLAUDE.md, struktur repo).
import sot from "../../../source/sot/constants.json";

it("Outcome sama dengan SOT enums.Outcome (nama = indeks uint8)", () => {
  expect(Object.entries(Outcome)).toEqual(sot.enums.Outcome.map((name, i) => [name, i]));
});

it("enum MarketStatus di schema.graphql sama dengan SOT enums.Status", () => {
  const schema = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");
  const body = schema.match(/enum MarketStatus \{([^}]*)\}/)?.[1] ?? "";
  expect(body.split(/\s+/).filter(Boolean)).toEqual(sot.enums.Status);
});
