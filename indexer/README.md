# backend/indexer: Envio HyperIndex

Indexer `LiveMarket` di Monad Testnet (10143) untuk riwayat pasar, posisi, dan leaderboard frontend. Spesifikasi: `../../source/docs/INDEXER.md`. Dibuat dengan perintah SOT `indexer.init` (`envio@3.0.0-alpha.21`).

Envio dipakai untuk: daftar pasar per partai (`MarketsByGame`), posisi dan status klaim/refund per wallet (`MyPositions`, halaman profil), leaderboard (`Leaderboard`, `User.netProfit`), serta statistik partai (`Game.marketCount`, `Game.totalVolume`).

## Isi

| File | Isi |
|---|---|
| `config.yaml` | Chain 10143, `start_block` = `addresses.deployBlock`, alamat `addresses.liveMarket`, 8 event (signature persis `sot/abi.json`), `field_selection.transaction_fields: [hash]`. HyperSync `https://10143.hypersync.xyz` dipilih otomatis oleh codegen |
| `schema.graphql` | Kontrak skema (INDEXER.md bagian 2): `Game`, `Market`, `Bet`, `Position`, `User`. `envio init` menimpa file ini; kembalikan dengan `git checkout indexer/schema.graphql` |
| `queries.graphql` | Query frontend. Bentuk hasil: `IndexedMarket`, `IndexedPosition`, `LeaderboardRow` di `@movemarket/shared` |
| `src/EventHandlers.ts` | Handler INDEXER.md bagian 3 |
| `src/sot.ts` | Salinan enum `Outcome` SOT. Indexer tidak mengimpor `@movemarket/shared` karena Envio Cloud hanya meng-clone repo ini; `test/sot.test.ts` mencocokkannya dengan `source/sot/constants.json` |
| `test/` | Vitest + `createTestIndexer()` (event simulasi, DB in-memory) |
| `.claude/skills/` | Skill bawaan `envio init` untuk versi ini (config, schema, handler, testing) |

## Perintah

Prasyarat: Node 22+ (24 disarankan), pnpm, Docker atau OrbStack (hanya untuk `dev`).

```bash
pnpm install
pnpm codegen          # wajib setelah config.yaml atau schema.graphql berubah
pnpm typecheck
pnpm test             # butuh ../../source berdampingan (test SOT)
TUI_OFF=true pnpm dev # Postgres + Hasura di Docker, GraphQL di http://localhost:8080/v1/graphql (console password: testing)
pnpm envio stop       # hentikan container dan hapus DB lokal
```

- **Token lokal:** HyperSync menolak query tanpa `ENVIO_API_TOKEN` (`/height` tetap terbuka). Untuk `pnpm dev` lokal, salin `.env.example` ke `.env` dan isi token gratis dari https://envio.dev/app/api-tokens. Envio Cloud tidak butuh token. Alternatif tanpa token: config salinan dengan `rpc: [{ url: https://testnet-rpc.monad.xyz, for: sync, interval_ceiling: 100 }]` di bawah chain, lalu `pnpm envio --config <file> dev` (cara verifikasi 10 Okt; tidak di-commit supaya event tidak ditulis dua kali).
- **OrbStack:** kalau `envio dev` tidak menemukan Docker, set `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`.
- Env var yang dibaca Envio wajib berawalan `ENVIO_`.

## Deploy ke Envio Cloud (dijalankan user, butuh login GitHub)

SOT `indexer.platform` dan `indexer.firstDeploy`. Indexer ada di subfolder `indexer/` repo `danustaif/movemarket-backend`.

```bash
npx envio-cloud login                                  # GitHub OAuth
npx envio-cloud config set-org <org>
npx envio-cloud repos                                  # pastikan movemarket-backend sudah tertaut dan bot Envio punya akses
npx envio-cloud indexer add --name movemarket-indexer --repo movemarket-backend \
  --root-dir indexer --config-file config.yaml --branch main --dry-run   # cek, lalu ulangi tanpa --dry-run
# setelah build pertama: push commit kosong supaya deployment baru terbentuk
git commit --allow-empty -m "indexer: trigger Envio Cloud" && git push
npx envio-cloud deployment status movemarket-indexer <commit> --watch-till-synced
# cek _meta (isReady true, progressBlock dekat head) di endpoint deployment, baru promote
npx envio-cloud deployment endpoint movemarket-indexer <commit>
npx envio-cloud deployment promote movemarket-indexer <commit>
```

Simpan URL GraphQL produksi di `VITE_ENVIO_URL` frontend.

## Verifikasi lokal (10 Oktober 2026)

Sumber RPC publik (tanpa token), `start_block` 69649726 sampai head 69654455: 31 event, sinkron sekitar 8 detik. Pasar 1 RESOLVED NO, 2 RESOLVED YES, 3-7 VOIDED `voidReason` 2, 8 VOIDED `voidReason` 3 dengan refund; pool, `lockTime`, dan `resolutionRequested` sama dengan `getMarket`, posisi wallet resolver sama dengan `getPosition`. Ketiga query di `queries.graphql` berjalan tanpa error.
