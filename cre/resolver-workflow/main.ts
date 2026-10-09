// Workflow resolver-workflow: ResolutionRequested -> getMarkets -> export Lichess + konsensus -> report ke LiveMarket.onReport.
// Spesifikasi: source/docs/CRE_WORKFLOW.md bagian 3 sampai 6. Berjalan di QuickJS/WASM: tanpa API Node.
import {
  EVMClient,
  HTTPClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  bytesToHex,
  consensusIdenticalAggregation,
  encodeCallMsg,
  getNetwork,
  handler,
  logTriggerConfig,
  ok,
  prepareReportRequest,
  text,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from "@chainlink/cre-sdk";
import { EVM_PB } from "@chainlink/cre-sdk/pb";
import { encodeReport, liveMarketAbi, sourceRequest, type CreHandlerResult } from "@movemarket/shared";
import { decodeFunctionResult, encodeFunctionData, zeroAddress } from "viem";
import {
  RESOLUTION_REQUESTED_TOPIC, batchProblem, configSchema, decodeResolutionRequested, openViews, parsePayload,
  payloadFromBody, type Config, type MarketView,
} from "./logic";

const out = (r: CreHandlerResult): string => JSON.stringify(r);

function evmClient(config: Config): EVMClient {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`unknown chain selector name ${config.chainSelectorName}`);
  return new EVMClient(network.chainSelector.selector);
}

/** Node mode: data masuk lewat argumen, jangan menyentuh runtime DON di sini. */
const fetchAndResolve = (sr: HTTPSendRequester, gameRef: string, base: string, views: readonly MarketView[]): string => {
  const req = sourceRequest(gameRef, base);
  const resp = sr.sendRequest({ url: req.url, method: "GET", headers: req.headers }).result();
  if (!ok(resp)) throw new Error(`lichess export HTTP ${resp.statusCode}`);
  return payloadFromBody(text(resp), req.format, views);
};

export const onResolutionRequested = (runtime: Runtime<Config>, log: EVMLog): string => {
  const cfg = runtime.config;
  const req = decodeResolutionRequested(log);
  const { gameRef } = req;

  const problem = batchProblem(req, cfg.maxMarketsPerReport);
  if (problem) {
    runtime.log(`${gameRef}: ${problem}`);
    return out({ gameRef, resolved: 0, skipped: req.ids.length, note: problem });
  }

  const evm = evmClient(cfg);
  const reply = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: cfg.liveMarketAddress,
        data: encodeFunctionData({ abi: liveMarketAbi, functionName: "getMarkets", args: [req.ids] }),
      }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result();
  const views = openViews(
    decodeFunctionResult({ abi: liveMarketAbi, functionName: "getMarkets", data: bytesToHex(reply.data) }),
    req.gameKey,
  );
  if (views.length === 0) return out({ gameRef, resolved: 0, skipped: req.ids.length, note: "nothing to resolve" });

  const payload = new HTTPClient()
    .sendRequest(runtime, fetchAndResolve, consensusIdenticalAggregation<string>())(gameRef, cfg.lichessBaseUrl, views)
    .result();
  const pairs = parsePayload(payload);
  const counts = { gameRef, resolved: pairs.ids.length, skipped: req.ids.length - pairs.ids.length };
  // Wajar kalau export Lichess masih tertinggal; resolver akan request ulang.
  if (pairs.ids.length === 0) return out({ ...counts, note: "nothing to resolve" });
  if (cfg.mode === "local-simulation") return out({ ...counts, mode: "local-simulation", note: payload });

  const report = runtime.report(prepareReportRequest(encodeReport({ gameKey: req.gameKey, ...pairs }))).result();
  const tx = evm
    .writeReport(runtime, { receiver: cfg.liveMarketAddress, report, gasConfig: { gasLimit: cfg.gasLimit } })
    .result();
  const receiverReverted = tx.receiverContractExecutionStatus === EVM_PB.ReceiverContractExecutionStatus.REVERTED;
  if (tx.txStatus !== TxStatus.SUCCESS || receiverReverted || !tx.txHash?.length) {
    throw new Error(`writeReport failed: ${TxStatus[tx.txStatus]}${receiverReverted ? " (receiver reverted)" : ""} ${tx.errorMessage ?? ""}`);
  }
  return out({ ...counts, txHash: bytesToHex(tx.txHash) });
};

export const initWorkflow = (config: Config) => [
  handler(
    evmClient(config).logTrigger(
      logTriggerConfig({
        addresses: [config.liveMarketAddress],
        topics: [[RESOLUTION_REQUESTED_TOPIC]],
        confidence: "FINALIZED",
      }),
    ),
    onResolutionRequested,
  ),
];

export async function main() {
  const runner = await Runner.newRunner({ configSchema });
  await runner.run(initWorkflow);
}
