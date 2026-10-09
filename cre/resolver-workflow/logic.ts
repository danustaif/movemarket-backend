// Logika murni workflow resolver-workflow, tanpa CRE runtime (diuji dengan `bun test`).
// Spesifikasi: source/docs/CRE_WORKFLOW.md bagian 4. Berjalan di QuickJS/WASM: tanpa API Node.
import {
  consensusPayload, liveMarketAbi, snapshotFrom,
  type CreWorkflowConfig, type MarketView, type ResolutionRequest, type SourceRequest,
} from "@movemarket/shared";
import { bytesToHex, decodeEventLog, getAbiItem, isAddress, toEventSelector, zeroAddress, type Address, type Hex } from "viem";
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

// batchProblem, openViews, MarketView, ResolutionRequest ada di source/shared (dipakai juga runner mock resolver, SOT D23).
export { batchProblem, openViews, type MarketView, type ResolutionRequest } from "@movemarket/shared";

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

/**
 * Bagian node mode: body export Lichess -> payload konsensus "id:code,..." (tanpa PENDING).
 * Konsensus dilakukan atas string ini, bukan atas body mentah (CRE_WORKFLOW.md bagian 4).
 */
export function payloadFromBody(body: string, format: SourceRequest["format"], views: readonly MarketView[]): string {
  return consensusPayload(snapshotFrom(format, body), views);
}
