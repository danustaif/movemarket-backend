// Map<gameRef, GameState>. Satu-satunya tempat deteksi koreksi langkah (RESOLVER_SERVICE 2.4).
import { Chess } from "chess.js";
import type { ApplyResult, GameRegistry, GameState, GameUpdate } from "../contracts.ts";

/** FEN setelah semua SAN legal. SAN ilegal (salah baca DGT) menghentikan replay di posisi terakhir yang legal. */
function fenOf(sans: readonly string[]): string {
  // ponytail: replay penuh tiap update (~200 ply), simpan instance Chess per partai kalau jadi bottleneck.
  const chess = new Chess();
  for (const san of sans) {
    try {
      chess.move(san);
    } catch {
      break;
    }
  }
  return chess.fen();
}

/** Aturan yang sama dengan predikat CASTLE di resolve(): SAN diawali O-O di ply sisi itu (putih ply ganjil). */
const castled = (sans: readonly string[]) => ({
  white: sans.some((s, i) => i % 2 === 0 && s.startsWith("O-O")),
  black: sans.some((s, i) => i % 2 === 1 && s.startsWith("O-O")),
});

/** Ply (1-based) pertama yang berbeda, atau null kalau `next` adalah perpanjangan `prev` (termasuk sama). */
function firstDiffPly(prev: readonly string[], next: readonly string[]): number | null {
  for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return i + 1;
  return null;
}

export function createGameRegistry(nowMs: () => number = Date.now): GameRegistry {
  const games = new Map<string, GameState>();

  return {
    apply(u: GameUpdate): ApplyResult {
      const prev = games.get(u.gameRef);
      const prevSans = prev?.sans ?? [];
      const diff = firstDiffPly(prevSans, u.sans);
      if (prev && diff === null && u.sans.length === prevSans.length && u.ended === prev.ended && u.result === prev.result) {
        return { kind: "unchanged" };
      }
      const state: GameState = { ...u, sans: [...u.sans], fen: fenOf(u.sans), castled: castled(u.sans), updatedAt: nowMs() };
      games.set(u.gameRef, state);
      if (diff !== null) return { kind: "corrected", state, firstDiffPly: diff };
      const newPlies = Array.from({ length: u.sans.length - prevSans.length }, (_, i) => prevSans.length + i + 1);
      return { kind: "advanced", state, newPlies };
    },
    get: (gameRef) => games.get(gameRef),
    all: () => [...games.values()],
    reset: (gameRef) => void games.delete(gameRef),
  };
}
