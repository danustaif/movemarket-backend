import { describe, expect, test } from "bun:test";
import { fetchSnapshot, gameFromExport } from "../../src/lichess/exportGame.ts";
import { FIXTURES } from "../helpers.ts";

const mate = await Bun.file(new URL("game-export.finished-mate.json", FIXTURES)).json();
const rapid = await Bun.file(new URL("game-export.ongoing-rapid.json", FIXTURES)).json();
const chapter = await Bun.file(new URL("study-chapter.cbVdruwJ.fGXnnaOp.pgn", FIXTURES)).text();

describe("gameFromExport", () => {
  test("partai selesai: speed dari field speed, hasil dari winner, replay", () => {
    const u = gameFromExport(mate, true);
    expect(u).toMatchObject({
      gameRef: "lichess:game:e9SJcXpJ", source: "replay", isReplay: true, speed: "bullet", ended: true, result: "1-0",
      white: { name: "chessasuke", rating: 2826 }, black: { name: "qdxds", rating: 2959 },
    });
    expect(u.sans).toHaveLength(59);
    expect(u.sans.at(-1)).toBe("Qxb7#");
  });

  test("partai berjalan: belum selesai, tanpa hasil", () => {
    const u = gameFromExport(rapid, false);
    expect(u).toMatchObject({ gameRef: "lichess:game:ymG9hwyh", source: "tv", speed: "rapid", ended: false });
    expect(u.result).toBeUndefined();
  });
});

describe("fetchSnapshot", () => {
  test("request sama dengan CRE (sourceRequest) untuk game JSON dan study PGN", async () => {
    const seen: { url: string; headers: unknown }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers });
      return url.endsWith(".pgn?clocks=false&comments=false&variations=false") ? new Response(chapter) : Response.json(mate);
    }) as unknown as typeof fetch;
    const g = await fetchSnapshot("lichess:game:e9SJcXpJ", f);
    expect(g).toMatchObject({ ended: true });
    expect(g.sans).toHaveLength(59);
    expect(seen[0]).toEqual({
      url: "https://lichess.org/game/export/e9SJcXpJ?moves=true&clocks=false&evals=false&opening=false",
      headers: { Accept: "application/json" },
    });
    const s = await fetchSnapshot("lichess:study:cbVdruwJ:fGXnnaOp", f);
    expect(s.sans.length).toBeGreaterThan(0);
  });

  test("HTTP gagal: throw", async () => {
    const f = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    await expect(fetchSnapshot("lichess:game:e9SJcXpJ", f)).rejects.toThrow(/429/);
  });
});
