import { expect, test } from "bun:test";
import { parsePgn } from "@movemarket/shared";
import type { GameUpdate } from "../src/contracts.ts";
import { createGameRegistry } from "../src/games/registry.ts";
import { fixture } from "./helpers.ts";

const upd = (sans: string[], p: Partial<GameUpdate> = {}): GameUpdate => ({
  gameRef: "lichess:study:cbVdruwJ:fGXnnaOp", source: "broadcast", speed: "classical",
  white: { name: "W" }, black: { name: "B" }, sans, ended: false, isReplay: false, ...p,
});

test("partai baru dan perpanjangan menghasilkan advanced dengan ply baru", () => {
  const r = createGameRegistry(() => 5);
  expect(r.apply(upd(["e4", "e5"]))).toMatchObject({ kind: "advanced", newPlies: [1, 2] });
  const res = r.apply(upd(["e4", "e5", "Nf3"]));
  expect(res).toMatchObject({ kind: "advanced", newPlies: [3], state: { updatedAt: 5 } });
  expect(r.apply(upd(["e4", "e5", "Nf3"]))).toEqual({ kind: "unchanged" });
  expect(r.apply(upd(["e4", "e5", "Nf3"], { ended: true, result: "1-0" }))).toMatchObject({ kind: "advanced", newPlies: [] });
  expect(r.all()).toHaveLength(1);
  r.reset("lichess:study:cbVdruwJ:fGXnnaOp");
  expect(r.get("lichess:study:cbVdruwJ:fGXnnaOp")).toBeUndefined();
});

test("koreksi broadcast (fixture study): sans baru bukan perpanjangan -> corrected dengan ply pertama yang beda", async () => {
  const { sans } = parsePgn(await fixture("study-chapter.cbVdruwJ.fGXnnaOp.pgn"));
  const r = createGameRegistry();
  r.apply(upd(sans.slice(0, 20)));
  const fixed = [...sans.slice(0, 9), "h3", ...sans.slice(10, 22)];
  expect(r.apply(upd(fixed))).toMatchObject({ kind: "corrected", firstDiffPly: 10 });
  expect(r.get(upd([]).gameRef)!.sans).toEqual(fixed);
  // stream mundur (ply terakhir dihapus) juga koreksi
  expect(r.apply(upd(fixed.slice(0, 15)))).toMatchObject({ kind: "corrected", firstDiffPly: 16 });
});

test("fen dari chess.js dan castled dari SAN", () => {
  const r = createGameRegistry();
  const res = r.apply(upd(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"]));
  if (res.kind !== "advanced") throw new Error(res.kind);
  expect(res.state.fen).toBe("r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4");
  expect(res.state.castled).toEqual({ white: true, black: false });
});

test("SAN ilegal tidak melempar; fen berhenti di posisi legal terakhir", () => {
  const r = createGameRegistry();
  const res = r.apply(upd(["e4", "Qxh1"]));
  if (res.kind !== "advanced") throw new Error(res.kind);
  expect(res.state.fen).toBe("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
});
