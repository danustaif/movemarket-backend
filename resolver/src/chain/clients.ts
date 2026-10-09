// Client viem untuk Monad Testnet (chain dari viem/chains, bukan definisi manual).
// Wallet resolver dan wallet faucet terpisah (SOT D19), masing-masing dengan nonceManager sendiri.
import { liveMarketAbi, mockUsdcAbi } from "@movemarket/shared";
import {
  createPublicClient, createWalletClient, http, parseGwei, webSocket,
  type Abi, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { privateKey, type Config } from "../config.ts";
import type { TxRequest, Write } from "./txQueue.ts";

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface ChainClients {
  publicClient: PublicClient;
  /** undefined kalau MONAD_TESTNET_WS kosong; watcher memakai getLogs saja. */
  wsClient?: PublicClient;
  /** undefined kalau RESOLVER_PRIVATE_KEY kosong. */
  resolverWallet?: Wallet;
  /** undefined kalau FAUCET_PRIVATE_KEY kosong. */
  faucetWallet?: Wallet;
}

export function createChainClients(cfg: Pick<Config, "rpcUrl" | "wsUrl">): ChainClients {
  const transport = http(cfg.rpcUrl);
  const wallet = (name: "RESOLVER_PRIVATE_KEY" | "FAUCET_PRIVATE_KEY") => {
    const key = privateKey(name);
    return key
      ? createWalletClient({ account: privateKeyToAccount(key, { nonceManager }), chain: monadTestnet, transport })
      : undefined;
  };
  return {
    publicClient: createPublicClient({ chain: monadTestnet, transport }) as PublicClient,
    wsClient: cfg.wsUrl ? (createPublicClient({ chain: monadTestnet, transport: webSocket(cfg.wsUrl) }) as PublicClient) : undefined,
    resolverWallet: wallet("RESOLVER_PRIVATE_KEY"),
    faucetWallet: wallet("FAUCET_PRIVATE_KEY"),
  };
}

// ponytail: tambahan priority fee untuk lockMarkets tidak ada di SOT; 2x estimasi + 1 gwei cukup untuk
// mendahului bet biasa. Pindahkan ke sot/constants.json kalau perlu disetel.
const URGENT_TIP = parseGwei("1");
const NOT_SUPPORTED = /method.*(not found|not supported|does not exist)|-32601/i;

/** Write untuk txQueue: writeContractSync (eth_sendRawTransactionSync), cadangan writeContract + receipt. */
export function contractWriter(
  wallet: Wallet, publicClient: PublicClient, addresses: { liveMarket: Address; mockUsdc: Address },
): { write: Write; resetNonce(): void } {
  let syncSupported = true;
  const write: Write = async (req: TxRequest) => {
    let fees = {};
    if (req.urgent) {
      const est = await publicClient.estimateFeesPerGas();
      const tip = est.maxPriorityFeePerGas * 2n + URGENT_TIP;
      fees = { maxPriorityFeePerGas: tip, maxFeePerGas: est.maxFeePerGas + tip };
    }
    const params = {
      address: addresses[req.target],
      abi: (req.target === "liveMarket" ? liveMarketAbi : mockUsdcAbi) as Abi,
      functionName: req.functionName,
      args: req.args,
      gas: req.gas,
      ...fees,
    };
    if (syncSupported) {
      try {
        return await wallet.writeContractSync({ ...params, throwOnReceiptRevert: true });
      } catch (err) {
        if (!NOT_SUPPORTED.test(String((err as Error)?.message))) throw err;
        syncSupported = false;
      }
    }
    const hash = await wallet.writeContract(params);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${req.functionName} revert: ${hash}`);
    return receipt;
  };
  return {
    write,
    resetNonce: () => nonceManager.reset({ address: wallet.account.address, chainId: monadTestnet.id }),
  };
}
