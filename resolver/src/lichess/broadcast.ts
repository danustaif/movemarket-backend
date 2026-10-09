// Ingest broadcast turnamen (sumber live utama, SOT D12 dan bagian 7.3).
// Stream PGN semua partai di round, dikirim ulang saat ada perubahan. chapterId dari tag GameURL.
import {
  SOT, chapterIdFromTags, parsePgn, parsePgnTags, splitPgnGames, type GameResult, type Player, type Speed,
} from "@movemarket/shared";
import type { GameFeed, GameUpdate } from "../contracts.ts";
import { sourceUrl, streamText, type StreamOpts } from "./stream.ts";

const RESULTS = new Set<string>(["1-0", "0-1", "1/2-1/2"]);

function player(name: string | undefined, elo: string | undefined): Player {
  const rating = Number(elo);
  return Number.isFinite(rating) && rating > 0 ? { name: name ?? "?", rating } : { name: name ?? "?" };
}

/** Setiap PGN partai di teks round -> GameUpdate. Partai tanpa chapterId valid dilewati. */
export function parseRoundPgn(text: string, roundId: string, speed: Speed): GameUpdate[] {
  const out: GameUpdate[] = [];
  for (const pgn of splitPgnGames(text)) {
    const tags = parsePgnTags(pgn);
    const chapterId = chapterIdFromTags(tags);
    if (!chapterId) continue;
    const snap = parsePgn(pgn);
    const result = RESULTS.has(tags.Result ?? "") ? (tags.Result as GameResult) : undefined;
    out.push({
      gameRef: `lichess:study:${roundId}:${chapterId}`,
      source: "broadcast",
      speed,
      white: player(tags.White, tags.WhiteElo),
      black: player(tags.Black, tags.BlackElo),
      sans: snap.sans,
      ended: snap.ended,
      ...(result ? { result } : {}),
      isReplay: false,
    });
  }
  return out;
}

/** GET broadcastRoundInfo: speed dari tour.info.fideTC (SOT speed.fromFideTC), lainnya unknown. */
export function parseRoundInfo(json: unknown): { speed: Speed; chapterIds: string[] } {
  const j = json as { tour?: { info?: { fideTC?: string } }; games?: { id?: string }[] };
  const map = SOT.speed.fromFideTC as Record<string, Speed>;
  return {
    speed: map[j.tour?.info?.fideTC ?? ""] ?? "unknown",
    chapterIds: (j.games ?? []).map((g) => g.id).filter((id): id is string => typeof id === "string"),
  };
}

export async function fetchRoundInfo(roundId: string, f: typeof fetch = fetch) {
  const res = await f(sourceUrl(SOT.lichess.sources.broadcastRoundInfo, { roundId }), { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`broadcast round ${roundId}: HTTP ${res.status}`);
  return parseRoundInfo(await res.json());
}

/**
 * Feed satu round. Buffer dipotong di batas partai lengkap (token hasil lalu dua baris kosong, seperti
 * fixture stream), sisanya disimpan sampai potongan berikutnya.
 */
export function createBroadcastFeed(o: { roundId: string; speed: Speed } & Omit<StreamOpts, "signal">): GameFeed {
  return {
    start(onUpdate) {
      const ac = new AbortController();
      let buf = "";
      const onText = (t: string) => {
        buf += t;
        const cut = buf.lastIndexOf("\n\n\n");
        if (cut < 0) return;
        const done = buf.slice(0, cut);
        buf = buf.slice(cut + 3);
        for (const u of parseRoundPgn(done, o.roundId, o.speed)) onUpdate(u);
      };
      const url = sourceUrl(SOT.lichess.sources.broadcastRoundStream, { roundId: o.roundId });
      void streamText(url, onText, { ...o, signal: ac.signal, onConnect: () => (buf = "") });
      return () => ac.abort();
    },
  };
}
