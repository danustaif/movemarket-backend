# movemarket-backend

Off-chain MoveMarket untuk Monad Testnet. Clone repo `movemarket-source` di sebelah repo ini (`../source`); paket `@movemarket/shared` diambil dari `../source/shared`.

| Folder | Isi | Spesifikasi |
|---|---|---|
| `resolver/` | Bun + Hono: ingest Lichess, planner, kunci ply, hasil sementara, requester, watcher, runner CRE, faucet, SSE, replay | `source/docs/RESOLVER_SERVICE.md` |
| `cre/` | Workflow Chainlink CRE `resolver-workflow` (resolusi final) | `source/docs/CRE_WORKFLOW.md` |
| `indexer/` | Envio HyperIndex (posisi, riwayat, leaderboard) | `source/docs/INDEXER.md` |

## Status (10 Oktober 2026)

| Bagian | Status |
|---|---|
| `resolver/` | Selesai untuk sumber replay dan broadcast: registry, planner, kunci ply, hasil sementara, requester (D17, D18), watcher proposed/finalized (D20), tx queue, runner CRE, faucet, SSE, route HTTP publik dan admin, pemulihan setelah restart. Sumber TV (Could) belum. Transaksi resolver menunggu `gas.limits` di SOT diukur di testnet; sampai itu `TxQueue` menolak mengirim dengan error jelas |
| `cre/` | Proyek dari `cre init`, handler `ResolutionRequested` sampai report `onReport`, build WASM lulus. Simulasi dengan tx nyata menunggu `LiveMarket` di-deploy. Detail: `cre/README.md` |
| `indexer/` | Hanya kontrak (`schema.graphql`, `queries.graphql`). `envio init` menunggu kontrak di-deploy dan terverifikasi |

Kontrak antarmuka modul resolver ada di `resolver/src/contracts.ts`; API HTTP dan SSE di `@movemarket/shared` (`ResolverRoutes`, `SseEvents`).

Belum ada: uji integrasi dengan anvil (kontrak + MockForwarder + resolver).

## Perintah

```bash
cd resolver && bun install && bun test && bun run typecheck
cp .env.example .env    # isi alamat kontrak dan secret; jangan commit
bun run dev             # tanpa alamat/secret: mode terbatas (HTTP, SSE, ingest, replay jalan; transaksi ditolak)

cd cre/resolver-workflow && bun install && bun test && bun run typecheck && bun run build
```
