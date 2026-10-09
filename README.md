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
| `indexer/` | Proyek `envio@3.0.0-alpha.21` dari perintah init SOT: config Monad Testnet, handler INDEXER.md bagian 3, test mock DB lulus. Diverifikasi lokal terhadap Monad Testnet (pasar 1-8 cocok dengan on-chain). Deploy Envio Cloud belum (butuh login user). Detail: `indexer/README.md` |

Kontrak antarmuka modul resolver ada di `resolver/src/contracts.ts`; API HTTP dan SSE di `@movemarket/shared` (`ResolverRoutes`, `SseEvents`).

Uji integrasi lokal (anvil + kontrak + MockForwarder + resolver, sumber replay dari fixture) ada di `resolver/test/integration/`; lihat Perintah.

## Perintah

```bash
cd resolver && bun install && bun test && bun run typecheck
cp .env.example .env    # isi alamat kontrak dan secret; jangan commit
bun run dev             # tanpa alamat/secret: mode terbatas (HTTP, SSE, ingest, replay jalan; transaksi ditolak)

# uji integrasi: anvil --chain-id 10143, deploy MockUSDC + LiveMarket + MockForwarder dari artefak forge,
# resolver (src/index.ts) sebagai proses anak dengan CRE_MODE=off, replay e9SJcXpJ dari sot/fixtures, report palsu
# lewat MockForwarder. Tanpa .env, tanpa jaringan luar (fetch selain loopback ditolak), sekitar 20 detik.
# Prasyarat: Foundry (anvil) dan artefak kontrak (dari root repo ini, smart-contract di sebelahnya):
#   cd ../smart-contract && git submodule update --init --recursive && forge build
# Tanpa prasyarat itu test dilewati dengan pesan; `bun test` biasa selalu melewatinya.
cd resolver && bun run test:integration

cd cre/resolver-workflow && bun install && bun test && bun run typecheck && bun run build

cd indexer && pnpm install && pnpm codegen && pnpm typecheck && pnpm test
TUI_OFF=true pnpm dev   # Docker; butuh ENVIO_API_TOKEN lokal, lihat indexer/README.md
```
