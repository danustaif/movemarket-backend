import { describe, expect, test } from "bun:test";
import { createBroadcastFeed, parseRoundInfo, parseRoundPgn } from "../../src/lichess/broadcast.ts";
import { streamText } from "../../src/lichess/stream.ts";
import type { GameUpdate } from "../../src/contracts.ts";

const FIX = new URL("../../../../source/sot/fixtures/lichess/", import.meta.url);
const roundPgn = await Bun.file(new URL("broadcast-round-stream.ZFuAnYX6.pgn", FIX)).text();
const roundJson = await Bun.file(new URL("broadcast-round.cbVdruwJ.json", FIX)).json();

describe("parseRoundPgn", () => {
  test("semua partai di round jadi GameUpdate dengan gameRef study dari GameURL", () => {
    const ups = parseRoundPgn(roundPgn, "ZFuAnYX6", "classical");
    expect(ups).toHaveLength(10);
    const first = ups[0]!;
    expect(first).toMatchObject({
      gameRef: "lichess:study:ZFuAnYX6:qY9Qw2nr", source: "broadcast", speed: "classical", isReplay: false, ended: false,
      white: { name: "Abdurramane, Danial Germano", rating: 1825 }, black: { name: "Jordan, William", rating: 2069 },
    });
    expect(first.sans.slice(0, 6)).toEqual(["e4", "d5", "exd5", "Nf6", "Nf3", "Qxd5"]);
    expect(first.result).toBeUndefined();
    expect(ups.at(-1)!.gameRef).toBe("lichess:study:ZFuAnYX6:04DQnyZn");
  });
});

describe("parseRoundInfo", () => {
  test("speed dari tour.info.fideTC (standard = classical) dan chapterId semua partai", () => {
    expect(parseRoundInfo(roundJson)).toEqual({ speed: "classical", chapterIds: ["fGXnnaOp", "L4AeZzmC", "yM0bK46p"] });
    expect(parseRoundInfo({ tour: { info: {} }, games: [] }).speed).toBe("unknown");
  });
});

/** Response yang mengalirkan potongan teks lalu selesai. */
const streamed = (parts: string[]) => new Response(new ReadableStream({
  start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
}));

describe("streamText", () => {
  test("429 tunggu 60 s, gagal lain backoff 1, 2, 4 ... maks 60, reset setelah tersambung", async () => {
    const waits: number[] = [];
    const responses: (() => Response)[] = [
      () => new Response("", { status: 429 }),
      () => new Response("", { status: 500 }),
      () => { throw new Error("ECONNRESET"); },
      () => streamed(["data"]),
      () => new Response("", { status: 503 }),
    ];
    const ac = new AbortController();
    const got: string[] = [];
    await streamText("http://x", (t) => got.push(t), {
      signal: ac.signal,
      fetch: (async () => { const r = responses.shift(); if (!r) { ac.abort(); throw new Error("stop"); } return r(); }) as unknown as typeof fetch,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(got).toEqual(["data"]);
    expect(waits).toEqual([60_000, 1_000, 2_000, 1_000, 2_000]);
  });
});

describe("createBroadcastFeed", () => {
  test("partai dikirim hanya setelah PGN-nya lengkap, walau potongan stream memotong di tengah", async () => {
    const games = roundPgn.split(/\n\n\n(?=\[Event )/);
    const twoGames = games.slice(0, 2).join("\n\n\n") + "\n\n\n";
    const cut = twoGames.indexOf("[Event", 10) + 30; // potong di tengah header partai kedua
    const ups: GameUpdate[] = [];
    let calls = 0;
    const feed = createBroadcastFeed({
      roundId: "ZFuAnYX6", speed: "rapid",
      fetch: (async () => {
        if (calls++ === 0) return streamed([twoGames.slice(0, cut), twoGames.slice(cut)]);
        return new Promise(() => {}); // sambungan kedua menggantung sampai stop
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    const stop = feed.start((u) => ups.push(u));
    await Bun.sleep(20);
    stop();
    expect(ups.map((u) => u.gameRef)).toEqual(["lichess:study:ZFuAnYX6:qY9Qw2nr", ups[1]!.gameRef]);
    expect(ups[1]!.gameRef).not.toBe(ups[0]!.gameRef);
    expect(ups.every((u) => u.speed === "rapid")).toBe(true);
  });
});
