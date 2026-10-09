// Logika murni workflow resolver-workflow, tanpa CRE runtime (diuji dengan `bun test`).
// Spesifikasi: source/docs/CRE_WORKFLOW.md bagian 4. Berjalan di QuickJS/WASM: tanpa API Node.
import {
  ENUMS, encodeConsensusPayload, gameKeyOf, liveMarketAbi, resolve, snapshotFrom,
  type CreWorkflowConfig, type MarketSpec, type SourceRequest,
} from "@movemarket/shared";
import {
  bytesToHex, decodeEventLog, getAbiItem, isAddress, toEventSelector, zeroAddress, type Address, type ContractFunctionReturnType, type Hex,
} from "viem";
import { z } from "zod";

/** config.<target>.json (CRE_WORKFLOW.md bagian 6). Mode tak dikenal dan alamat placeholder ditolak. */
export const configSchema = z.object({
  mode: z.enum(["onchain", "local-simulation"]),
  chainSelectorName: z.literal("monad-testnet"),
  liveMarketAddress: z
    .string()
    .refine((a): a is Address => isAddress(a) && a !== zeroAddress, "liveMarketAddress must be the deployed LiveMarket"),
  gasLimit: z.string().regex(/^[1-9]\d*$/, "gasLimit must be a decimal string"),
  maxMarketsPerReport: z.number().int().positive(),
  // Bukan z.url(): validator URL zod gagal di QuickJS (terlihat saat simulate), jadi pakai regex.
  lichessBaseUrl: z.string().regex(/^https:\/\/[^\s/]+$/, "lichessBaseUrl must be https://<host> without trailing slash"),
}) satisfies z.ZodType<CreWorkflowConfig>;

export type Config = z.infer<typeof configSchema>;

export const RESOLUTION_REQUESTED_TOPIC = toEventSelector(getAbiItem({ abi: liveMarketAbi, name: "ResolutionRequested" }));

export interface ResolutionRequest {
  gameKey: Hex;
  gameRef: string;
  ids: readonly bigint[];
}

/** Field byte Log CRE berupa Uint8Array. */
export function decodeResolutionRequested(log: { topics: Uint8Array[]; data: Uint8Array }): ResolutionRequest {
  const { args } = decodeEventLog({
    abi: liveMarketAbi,
    eventName: "ResolutionRequested",
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    data: bytesToHex(log.data),
  });
  return { gameKey: args.gameKey, gameRef: args.gameRef, ids: args.ids };
}

/** null kalau batch layak diproses; selain itu catatan alasan berhenti tanpa menulis. */
export function batchProblem(req: ResolutionRequest, maxMarketsPerReport: number): string | null {
  if (gameKeyOf(req.gameRef) !== req.gameKey) return "gameKey mismatch";
  if (req.ids.length === 0) return "empty batch";
  if (req.ids.length > maxMarketsPerReport) return "batch too large";
  return null;
}

/** Satu elemen hasil getMarkets (struct MarketView di sot/abi.json). */
export type MarketView = ContractFunctionReturnType<typeof liveMarketAbi, "view", "getMarkets">[number];

const STATUS_OPEN = ENUMS.Status.indexOf("OPEN");

/** Hanya pasar OPEN milik partai ini yang ikut di-resolve. */
export const openViews = (views: readonly MarketView[], gameKey: Hex): MarketView[] =>
  views.filter((v) => v.status === STATUS_OPEN && v.gameKey.toLowerCase() === gameKey.toLowerCase());

/**
 * Bagian node mode: body export Lichess -> payload konsensus "id:code,..." (tanpa PENDING).
 * Konsensus dilakukan atas string ini, bukan atas body mentah (CRE_WORKFLOW.md bagian 4).
 */
export function payloadFromBody(body: string, format: SourceRequest["format"], views: readonly MarketView[]): string {
  const game = snapshotFrom(format, body);
  return encodeConsensusPayload(views.map((v) => ({ id: v.id, outcome: resolve(game, v as MarketSpec) })));
}
