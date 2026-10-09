// Kontrak modul resolver service. Spesifikasi: source/docs/RESOLVER_SERVICE.md, source/docs/RESOLUTION_SPEC.md bagian 9.
// API HTTP dan SSE ada di @movemarket/shared (ResolverRoutes, SseEvents); file ini hanya modul internal.
//
// Alur per ply (urutan wajib): GameRegistry.apply -> SSE ply -> MarketEngine.onPly (kunci, sementara, rencana).
// Batas tanggung jawab: resolver tidak pernah menulis hasil final; itu hanya dari CRE lewat forwarder.
import type {
  CreHandlerResult, CreMode, FaucetResponse, FinalOutcome, GameResult, GameSourceKind, Player, PositionDto,
  ResolveOutcome, Speed, SseEvents, VoidReasonCode, liveMarketAbi,
} from "@movemarket/shared";
import type { Address, ContractEventArgsFromTopics, ContractEventName, ContractFunctionArgs, Hex, TransactionReceipt } from "viem";

type LiveMarketAbi = typeof liveMarketAbi;
export type Stop = () => void;

// ======================================================================= ingest Lichess

/** Snapshot lengkap partai dari sebuah feed. sans selalu lengkap dan ternormalisasi, bukan delta. */
export interface GameUpdate {
  gameRef: string;
  source: GameSourceKind;
  speed: Speed;
  white: Player;
  black: Player;
  sans: string[];
  ended: boolean;
  result?: GameResult;
  isReplay: boolean;
}

/**
 * Seam ingest dengan tiga adapter: broadcast (Must), replay (Must), TV (Could, chess.js UCI -> SAN).
 * Satu koneksi stream panjang per sumber, reconnect backoff 1..60 s, HTTP 429 tunggu 60 s.
 */
export interface GameFeed {
  start(onUpdate: (u: GameUpdate) => void): Stop;
}

export interface GameState extends GameUpdate {
  fen: string;
  castled: { white: boolean; black: boolean };
  updatedAt: number; // ms
}

export type ApplyResult =
  | { kind: "unchanged" }
  | { kind: "advanced"; state: GameState; newPlies: number[] }
  /** sans baru bukan perpanjangan sans lama (koreksi DGT broadcast): hitung ulang hasil sementara. */
  | { kind: "corrected"; state: GameState; firstDiffPly: number };

/** Map<gameRef, GameState>. Satu-satunya tempat deteksi koreksi langkah. */
export interface GameRegistry {
  apply(u: GameUpdate): ApplyResult;
  get(gameRef: string): GameState | undefined;
  all(): GameState[];
  untrack(gameRef: string): void;
}

// ======================================================================= pasar

/** Pasar yang diketahui resolver, dibangun dari event LiveMarket (bisa direkonstruksi sejak DEPLOY_BLOCK). */
export interface TrackedMarket {
  id: bigint;
  gameRef: string;
  marketType: 0 | 1 | 2;
  side: 0 | 1 | 2;
  fromPly: number;
  toPly: number;
  lockTime: number;
  resolveDeadline: number;
  poolYes: bigint;
  poolNo: bigint;
  provisional: ResolveOutcome;
  requested: boolean;
  final: FinalOutcome | null;
  /** Diisi dari MarketVoided. 2 (NO_WINNERS) dihitung cocok dengan hasil sementara YES/NO. */
  voidReason: VoidReasonCode | null;
}

/** Input createMarkets, persis struct MarketParams di ABI. */
export type MarketParams = ContractFunctionArgs<LiveMarketAbi, "nonpayable", "createMarkets">[0][number];

/** Fungsi murni planner (RESOLUTION_SPEC bagian 9). Kosong kalau syarat spawn tidak terpenuhi. */
export type PlanMarkets = (state: GameState, markets: readonly TrackedMarket[], nowSec: number) => MarketParams[];

/** Fungsi murni kunci ply (SOT D11): id dengan currentPly >= fromPly - LOCK_LEAD_PLIES dan nowSec < lockTime. */
export type LocksDue = (state: GameState, markets: readonly TrackedMarket[], nowSec: number) => bigint[];

/**
 * Orkestrator per ply. Urutan di dalam: kunci (lockMarkets, prioritas tertinggi) -> hasil sementara
 * (SSE provisional, masukkan ke Requester hanya kalau pasar punya stake, SOT D18) -> rencana (createMarkets).
 */
export interface MarketEngine {
  onPly(state: GameState, nowSec: number): Promise<void>;
  /** Setelah koreksi: hitung ulang hasil sementara semua pasar partai yang belum final. */
  onCorrection(state: GameState): void;
  /** Per partai. Replay tanpa penonton (SOT D16): berhenti membuat pasar baru, tetap kunci dan selesaikan. */
  setSpawning(gameRef: string, enabled: boolean): void;
}

/** State pasar dan posisi di memori, diisi ChainWatcher. Cadangan indexer untuk GET /positions/:address. */
export interface MarketStore {
  byGame(gameRef: string): TrackedMarket[];
  get(id: bigint): TrackedMarket | undefined;
  /** claimable dibaca dari kontrak saat dipanggil. */
  positions(address: Address): Promise<PositionDto[]>;
}

/**
 * Requester (SOT D14, D17, D18). Batch maks REQUEST_MAX_BATCH per gameRef, flush tiap REQUEST_FLUSH_SEC.
 * Prasyarat export: id hanya dikirim kalau resolve() atas sourceRequest(gameRef) sudah bukan PENDING dan
 * sama dengan hasil sementara. Retry hanya id yang masih OPEN setelah FINAL_WAIT_SEC, backoff RETRY_BACKOFF_SEC,
 * lalu log cre_failed untuk keputusan operator.
 */
export interface Requester {
  add(gameRef: string, ids: readonly bigint[]): void;
  /** Dipanggil saat MarketResolved atau MarketVoided terlihat finalized. */
  settled(id: bigint): void;
}

// ======================================================================= chain

/** Transaksi wallet resolver. Prioritas dari jenisnya: lockMarkets > adminVoid > createMarkets > requestResolution > mint. */
export type ResolverTx =
  | { kind: "lockMarkets"; ids: bigint[] }
  | { kind: "createMarkets"; params: MarketParams[] }
  | { kind: "requestResolution"; gameRef: string; ids: bigint[] }
  | { kind: "mint"; to: Address; amount: bigint }
  /** POST /admin/void. Butuh wallet resolver = owner LiveMarket; kalau bukan, kontrak revert. */
  | { kind: "adminVoid"; ids: bigint[] };

/**
 * Antrian tunggal wallet resolver dengan nonceManager viem. Gas eksplisit base + perMarket x n dari
 * SOT.gas.limits; lockMarkets dengan priority fee lebih tinggi. Retry sekali untuk nonce/underpriced.
 */
export interface TxQueue {
  send(tx: ResolverTx): Promise<TransactionReceipt>;
}

export type LiveMarketEventName = ContractEventName<LiveMarketAbi>;
export type LiveMarketEvent = {
  [E in LiveMarketEventName]: { name: E; args: ContractEventArgsFromTopics<LiveMarketAbi, E>; txHash: Hex; blockNumber: bigint };
}[LiveMarketEventName];

/**
 * WebSocket eth_subscribe logs (MONAD_TESTNET_WS), cadangan getLogs. Setiap event dikirim dua kali:
 * "proposed" (untuk tampilan: pool, created, locked) lalu "finalized" (untuk aksi tidak bisa dibatalkan:
 * runner CRE, SSE finalized), SOT D20.
 */
export interface ChainWatcher {
  subscribe(fn: (ev: LiveMarketEvent, finality: "proposed" | "finalized") => void): Stop;
}

// ======================================================================= CRE

/**
 * Aktif hanya kalau CRE_MODE=simulate. Konkurensi 1, timeout CRE_RUN_TIMEOUT_SEC. Menjalankan
 * `cre workflow simulate resolver-workflow --target <CRE_TARGET> --non-interactive --trigger-index 0
 *  --evm-tx-hash <txHash> --evm-event-index 0 --broadcast` dan mengurai string JSON hasil handler.
 * Hanya dipanggil untuk ResolutionRequested yang bloknya sudah finalized.
 */
export interface CreRunner {
  run(requestTxHash: Hex): Promise<CreHandlerResult>;
}

// ======================================================================= faucet

/** Wallet faucet terpisah dari wallet resolver (SOT D19). Batas di memori. */
export interface Faucet {
  /** Mint tUSDC + kirim MON. Kuota alamat hanya terpakai kalau MON terkirim. */
  onboard(address: Address, ip: string): Promise<FaucetResponse>;
  /** Isi ulang gas kalau saldo < gasTopUpThresholdWei. Kuota per alamat dan per IP. */
  topUpGas(address: Address, ip: string): Promise<{ monTx: Hex }>;
}

export class FaucetError extends Error {
  constructor(readonly status: 400 | 409 | 429, readonly code?: "GAS_TOPUP_LIMIT" | "FAUCET_FAILED") {
    super(code ?? String(status));
  }
}

// ======================================================================= SSE dan replay

export interface SseHub {
  publish<E extends keyof SseEvents>(event: E, data: SseEvents[E]): void;
  /** Handler GET /stream[?gameRef=]. Ping tiap SSE_PING_SEC. */
  handle(req: Request): Response;
  viewers(): number;
}

/**
 * Replay partai selesai sebagai GameFeed (isReplay = true), mulai di REPLAY_START_PLY.
 * Scheduler otomatis: tidak ada partai live selama AUTO_REPLAY_IDLE_MIN dan ada penonton -> ambil dari
 * REPLAY_POOL (hanya classical/rapid, lainnya log replay_rejected). Satu replay aktif.
 */
export interface Replayer {
  start(gameId: string, plyIntervalSec?: number): Promise<string>; // gameRef
  stop(): void;
}

// ======================================================================= config

/** Dibaca dari env (lihat .env.example); default dari sot/constants.json, env hanya override. */
export interface ResolverConfig {
  port: number;
  rpcUrl: string;
  wsUrl: string;
  liveMarket: Address;
  mockUsdc: Address;
  deployBlock: bigint;
  creMode: CreMode;
  creProjectDir: string;
  creTarget: string;
  corsOrigin: string;
  replayPool: string[];
  // Secret (RESOLVER_PRIVATE_KEY, FAUCET_PRIVATE_KEY, ADMIN_TOKEN) tidak disimpan di objek config
  // yang bisa dicetak; dibaca langsung saat membuat client.
}
