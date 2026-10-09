# movemarket-backend

Off-chain MoveMarket untuk Monad Testnet. Clone repo `movemarket-source` di sebelah repo ini (`../source`); paket `@movemarket/shared` diambil dari `../source/shared`.

| Folder | Isi | Spesifikasi |
|---|---|---|
| `resolver/` | Bun + Hono: ingest Lichess, planner, kunci ply, hasil sementara, requester, watcher, runner CRE, faucet, SSE, replay | `source/docs/RESOLVER_SERVICE.md` |
| `cre/` | Workflow Chainlink CRE `resolver-workflow` (resolusi final) | `source/docs/CRE_WORKFLOW.md` |
| `indexer/` | Envio HyperIndex (posisi, riwayat, leaderboard) | `source/docs/INDEXER.md` |

## Status

Tahap antarmuka:
- `resolver/src/contracts.ts`: modul internal (`GameFeed`, `GameRegistry`, `MarketEngine`, `PlanMarkets`, `LocksDue`, `Requester`, `TxQueue`, `ChainWatcher`, `CreRunner`, `Faucet`, `SseHub`, `Replayer`, `ResolverConfig`). API HTTP dan SSE ada di `@movemarket/shared` (`ResolverRoutes`, `SseEvents`).
- `cre/README.md`: kontrak workflow; proyek dibuat dengan `cre init`, bukan manual.
- `indexer/schema.graphql`, `indexer/queries.graphql`.

## Perintah

```bash
cd resolver && bun install && bun run typecheck
```
