// Nilai uji dibaca dari source/sot (bukan literal), hanya untuk *.test.ts.
import type { Hex } from "viem";

const SOT_DIR = new URL("../../../source/sot/", import.meta.url);
const vectors = (await Bun.file(new URL("test-vectors.json", SOT_DIR)).json()) as { gameKey: { gameRef: string; expected: Hex }[] };
const abi = (await Bun.file(new URL("abi.json", SOT_DIR)).json()) as { computed: { events: Record<string, Hex> } };

export const GAME_REF = "lichess:game:e9SJcXpJ";
/** sot/test-vectors.json gameKey. */
export const GAME_KEY = vectors.gameKey.find((v) => v.gameRef === GAME_REF)!.expected;
/** sot/abi.json computed.events: topic0 ResolutionRequested. */
export const TOPIC0 = Object.entries(abi.computed.events).find(([sig]) => sig.startsWith("ResolutionRequested("))![1];
