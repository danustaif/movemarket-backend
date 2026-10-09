// Client viem untuk Monad Testnet (chain dari viem/chains, bukan definisi manual).
// Wallet resolver dan wallet faucet terpisah (SOT D19), masing-masing dengan nonceManager sendiri.
import { SOT, liveMarketAbi, mockUsdcAbi } from "@movemarket/shared";
import {
  createPublicClient, createWalletClient, http, webSocket,
  type Abi, type Account, type Address, type Chain, type PublicClient, type Transport, type WalletClient,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { privateKey, type Config, type PrivateKeyName } from "../config.ts";
import { mockForwarderAbi } from "../cre/mockRunner.ts";
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
  const wallet = (name: PrivateKeyName) => {
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

const PRIORITY = SOT.gas.lockMarketsPriorityFee;

/** Fee lockMarkets (SOT gas.lockMarketsPriorityFee): tip = estimasi x estimateMultiplier + extraTipWei. */
export function lockMarketsFees(est: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
  const tip = est.maxPriorityFeePerGas * BigInt(PRIORITY.estimateMultiplier) + BigInt(PRIORITY.extraTipWei);
  return { maxPriorityFeePerGas: tip, maxFeePerGas: est.maxFeePerGas + tip };
}

const NOT_SUPPORTED = /method.*(not found|not supported|does not exist)|-32601/i;

const ABIS = { liveMarket: liveMarketAbi, mockUsdc: mockUsdcAbi, forwarder: mockForwarderAbi } as const;

/**
 * Write untuk txQueue: writeContractSync (eth_sendRawTransactionSync), cadangan writeContract + receipt.
 * forwarder (CRE_MODE=mock, SOT D23) default addresses.creMockKeystoneForwarder.
 */
export function contractWriter(
  wallet: Wallet, publicClient: PublicClient, addresses: { liveMarket: Address; mockUsdc: Address; forwarder?: Address },
): { write: Write; resetNonce(): void } {
  const to = { forwarder: SOT.addresses.creMockKeystoneForwarder as Address, ...addresses };
  let syncSupported = true;
  const write: Write = async (req: TxRequest) => {
    const fees = req.urgent ? lockMarketsFees(await publicClient.estimateFeesPerGas()) : {};
    const params = {
      address: to[req.target],
      abi: ABIS[req.target] as Abi,
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
