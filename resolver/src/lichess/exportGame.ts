// Export partai Lichess (SOT bagian 7.2). Sumber yang sama dengan CRE: sourceRequest + parser dari shared.
import {
  parseLichessJson, parsePgn, sourceRequest, type GameResult, type Player, type Snapshot, type Speed,
} from "@movemarket/shared";
import type { GameUpdate } from "../contracts.ts";

const SPEEDS = new Set<Speed>(["classical", "rapid", "blitz", "bullet"]);

type ExportPlayer = { user?: { name?: string }; rating?: number; aiLevel?: number };
interface ExportJson {
  id: string;
  speed?: string;
  winner?: "white" | "black";
  players?: Record<"white" | "black", ExportPlayer>;
}

/** Pemain untuk semua sumber (export JSON, tag PGN broadcast). Rating hanya kalau angka positif. */
export function player(name: string | undefined, rating: number | undefined): Player {
  const n = name ?? "?";
  return rating !== undefined && Number.isFinite(rating) && rating > 0 ? { name: n, rating } : { name: n };
}

const exportPlayer = (p: ExportPlayer | undefined) =>
  player(p?.user?.name ?? (p?.aiLevel ? `Stockfish level ${p.aiLevel}` : "Anonymous"), p?.rating);

/** JSON export -> GameUpdate. isReplay menentukan source: replay, selain itu tv (satu-satunya sumber live game). */
export function gameFromExport(json: unknown, isReplay: boolean): GameUpdate {
  const j = json as ExportJson;
  const snap = parseLichessJson(json);
  const speed = SPEEDS.has(j.speed as Speed) ? (j.speed as Speed) : "unknown";
  let result: GameResult | undefined;
  if (snap.ended) result = j.winner === "white" ? "1-0" : j.winner === "black" ? "0-1" : "1/2-1/2";
  return {
    gameRef: `lichess:game:${j.id}`,
    source: isReplay ? "replay" : "tv",
    speed,
    white: exportPlayer(j.players?.white),
    black: exportPlayer(j.players?.black),
    sans: snap.sans,
    ended: snap.ended,
    ...(result ? { result } : {}),
    isReplay,
  };
}

async function get(gameRef: string, f: typeof fetch): Promise<Response> {
  const req = sourceRequest(gameRef);
  const res = await f(req.url, { headers: req.headers });
  if (!res.ok) throw new Error(`export ${gameRef}: HTTP ${res.status}`);
  return res;
}

/** JSON export mentah satu game (untuk replay). */
export async function fetchGameJson(gameId: string, f: typeof fetch = fetch): Promise<unknown> {
  return (await get(`lichess:game:${gameId}`, f)).json();
}

/** Snapshot dari export resmi untuk gameRef apa pun, persis seperti yang dibaca CRE (prasyarat D17). */
export async function fetchSnapshot(gameRef: string, f: typeof fetch = fetch): Promise<Snapshot> {
  const format = sourceRequest(gameRef).format;
  const res = await get(gameRef, f);
  return format === "json" ? parseLichessJson(await res.json()) : parsePgn(await res.text());
}
