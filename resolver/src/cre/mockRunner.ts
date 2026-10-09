// Runner CRE untuk CRE_MODE=mock (SOT D23, RESOLVER_SERVICE.md 2.7a). Hanya testnet, sambil menunggu Early Access:
// langkah handler workflow (CRE_WORKFLOW.md bagian 4) dengan fungsi yang sama dari source/shared, lalu report() di
// MockKeystoneForwarder lewat antrian wallet resolver. Bukan konsensus multi-node; dipercaya seperti resolver.
// Dipanggil hanya untuk ResolutionRequested yang bloknya sudah finalized (SOT D20).
import {
  SOT, batchProblem, consensusPayload, encodeReport, liveMarketAbi, openViews, parseConsensusPayload,
  type CreHandlerResult, type Snapshot,
} from "@movemarket/shared";
import {
  concat, isAddressEqual, keccak256, numberToHex, parseAbi, parseEventLogs, stringToHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import type { CreRunner, TxQueue } from "../contracts.ts";

/**
 * Bagian MockKeystoneForwarder yang dipakai (smartcontractkit/chainlink-evm contracts/cre/src/dev/MockKeystoneForwarder.sol).
 * report() permissionless, tidak memeriksa tanda tangan atau execution id ganda, dan TIDAK revert kalau onReport revert:
 * hasilnya hanya ReportProcessed.result (SOT bagian 16).
 */
export const mockForwarderAbi = parseAbi([
  "function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)",
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
]);

// Nilai metadata selain execution id dan timestamp: sama dengan report CLI simulate (tx 0xb9ee...13c5), kecuali nama
// workflow "mock-cre" supaya report mock bisa dibedakan. LiveMarket.onReport tidak membaca metadata.
const DON_ID = 1;
const DON_CONFIG_VERSION = 1;
const WORKFLOW_CID: Hex = `0x${"11".repeat(32)}`;
const WORKFLOW_NAME = stringToHex("mock-cre", { size: 10 });
const WORKFLOW_OWNER: Hex = `0x${"aa".repeat(20)}`;
const REPORT_ID: Hex = "0x0001";

/**
 * Metadata 109 byte di depan report: versi 01 | execution id 32 | timestamp 4 | DON id 4 | versi config DON 4 |
 * workflow CID 32 | nama workflow 10 | owner 20 | report id 2. Forwarder meneruskan byte 45..109 ke onReport.
 */
export const reportMetadata = (executionId: Hex, timestampSec: number): Hex => concat([
  "0x01", executionId, numberToHex(timestampSec, { size: 4 }), numberToHex(DON_ID, { size: 4 }),
  numberToHex(DON_CONFIG_VERSION, { size: 4 }), WORKFLOW_CID, WORKFLOW_NAME, WORKFLOW_OWNER, REPORT_ID,
]);

export interface MockCreDeps {
  client: Pick<PublicClient, "getTransactionReceipt" | "readContract">;
  liveMarket: Address;
  /** Default SOT addresses.creMockKeystoneForwarder; harus sama dengan alamat forwarder di contractWriter. */
  forwarder?: Address;
  /** Export resmi Lichess, sumber yang sama dengan CRE (lichess/exportGame.ts fetchSnapshot). */
  fetchSnapshot: (gameRef: string) => Promise<Snapshot>;
  /** Antrian wallet resolver, supaya nonce tidak bentrok dengan transaksi lain. */
  tx: Pick<TxQueue, "send">;
  nowSec: () => number;
}

export function createMockCreRunner(d: MockCreDeps): CreRunner {
  const forwarder = d.forwarder ?? (SOT.addresses.creMockKeystoneForwarder as Address);
  const attempts = new Map<Hex, number>();
  const fromLiveMarket = (l: { address: Address }) => isAddressEqual(l.address, d.liveMarket);

  return {
    async run(requestTxHash) {
      // 1. Decode ResolutionRequested dari tx request (event index 0, sama dengan --evm-event-index 0).
      const request = await d.client.getTransactionReceipt({ hash: requestTxHash });
      const ev = parseEventLogs({ abi: liveMarketAbi, eventName: "ResolutionRequested", logs: request.logs }).find(fromLiveMarket);
      if (!ev) throw new Error(`tx ${requestTxHash} tanpa ResolutionRequested dari LiveMarket`);
      const req = ev.args;
      const done = (note: string): CreHandlerResult => ({ gameRef: req.gameRef, resolved: 0, skipped: req.ids.length, note });

      // 2. Validasi batch.
      const problem = batchProblem(req, SOT.cre.maxMarketsPerReport);
      if (problem) return done(problem);

      // 3. getMarkets di blok finalized, buang yang bukan OPEN atau gameKey beda.
      const views = openViews(
        await d.client.readContract({ address: d.liveMarket, abi: liveMarketAbi, functionName: "getMarkets", args: [req.ids], blockTag: "finalized" }),
        req.gameKey,
      );
      if (views.length === 0) return done("nothing to resolve");

      // 4-5. Export resmi -> resolve -> payload "id:code" (tanpa PENDING) -> pasangan report.
      const pairs = parseConsensusPayload(consensusPayload(await d.fetchSnapshot(req.gameRef), views));
      if (pairs.ids.length === 0) return done("nothing to resolve");

      // 6-7. rawReport = metadata + report, lalu report() di forwarder.
      const attempt = (attempts.get(requestTxHash) ?? 0) + 1;
      attempts.set(requestTxHash, attempt); // ponytail: Map tanpa batas, satu entri per request; cukup untuk umur proses
      const executionId = keccak256(concat([requestTxHash, numberToHex(attempt, { size: 32 })]));
      const rawReport = concat([reportMetadata(executionId, d.nowSec()), encodeReport({ gameKey: req.gameKey, ...pairs })]);
      const receipt = await d.tx.send({ kind: "creReport", receiver: d.liveMarket, rawReport });
      if (receipt.status !== "success") throw new Error(`report revert: ${receipt.transactionHash}`);

      // 8. Forwarder tidak revert saat onReport revert: cek ReportProcessed.result.
      const ok = parseEventLogs({ abi: mockForwarderAbi, eventName: "ReportProcessed", logs: receipt.logs })
        .find((l) => isAddressEqual(l.address, forwarder) && isAddressEqual(l.args.receiver, d.liveMarket));
      if (!ok?.args.result) throw new Error(`ReportProcessed ${ok ? "result=false (onReport revert)" : "tidak ada"}: ${receipt.transactionHash}`);

      const settled = parseEventLogs({ abi: liveMarketAbi, eventName: ["MarketResolved", "MarketVoided"], logs: receipt.logs })
        .filter(fromLiveMarket).length;
      return { gameRef: req.gameRef, resolved: settled, skipped: req.ids.length - settled, txHash: receipt.transactionHash, note: "mock-cre" };
    },
  };
}
