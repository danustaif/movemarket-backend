# backend/indexer: Envio HyperIndex

Proyek Envio **belum di-init**; prasyarat: `LiveMarket` sudah di-deploy dan terverifikasi. Langkah dan handler: `../../source/docs/INDEXER.md`.

## Kontrak

| File | Isi |
|---|---|
| `schema.graphql` | Entity `Game`, `Market`, `Bet`, `Position`, `User`. `envio init` menimpa file ini; kembalikan dengan `git checkout` |
| `queries.graphql` | Query yang dipakai frontend. Bentuk hasil: `IndexedMarket`, `IndexedPosition`, `LeaderboardRow` di `@movemarket/shared` |

Event yang diindeks (signature persis `source/sot/abi.json`): `MarketCreated`, `MarketLocked`, `BetPlaced`, `ResolutionRequested`, `MarketResolved`, `MarketVoided`, `Claimed`, `Refunded`. `config.yaml` wajib memuat `field_selection.transaction_fields: [hash]`.
