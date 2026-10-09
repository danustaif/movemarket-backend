# backend/cre: workflow `resolver-workflow`

Proyek CRE `movemarket-cre`, dibuat dengan `cre init --non-interactive` (CLI v1.33.0, template `hello-world-ts`, registry `private`), lalu isinya dipindah ke folder ini supaya cocok dengan `CRE_PROJECT_DIR=../cre` di resolver. Spesifikasi: `../../source/docs/CRE_WORKFLOW.md`.

## Struktur

```
backend/cre/                      root proyek CRE (jalankan semua perintah `cre` dari sini)
  project.yaml                    RPC monad-testnet untuk tiga target
  secrets.yaml, .env              dari template, di-gitignore, tidak dipakai (tanpa secret; jangan dibuka)
  resolver-workflow/
    workflow.yaml                 target staging-settings, production-settings, local-simulation
    config.<target>.json          CreWorkflowConfig, divalidasi zod (logic.ts configSchema)
    main.ts                       trigger + handler (CRE SDK)
    logic.ts                      logika murni: decode log, validasi batch, filter OPEN, payload konsensus, parse payload
    main.test.ts, logic.test.ts   bun test (runtime uji SDK + fixture SOT di tempatnya)
```

Kode bersama diimpor sebagai paket `@movemarket/shared` (`file:../../../source/shared`, sama seperti resolver). `cre workflow build` berhasil me-resolve paket ini dan mem-bundle JSON SOT yang diimpornya, jadi script `sync:shared` tidak dibuat. Kalau `source/shared` mendapat file baru dan tidak terlihat: `bun install --force` di `resolver-workflow/`.

## Kontrak workflow

| Sisi | Kontrak | Sumber tipe |
|---|---|---|
| Trigger | EVM log `ResolutionRequested(bytes32 indexed gameKey, string gameRef, uint256[] ids)` dari `LiveMarket`, chain `monad-testnet`, confidence `FINALIZED`. Topic0 dihitung dari `liveMarketAbi` | `liveMarketAbi` |
| Validasi | `gameKeyOf(gameRef) == gameKey`, 1 sampai `maxMarketsPerReport` id. Gagal: kembalikan `note` tanpa membaca kontrak | `gameKeyOf` |
| Baca kontrak | `getMarkets(ids)` di `LAST_FINALIZED_BLOCK_NUMBER`, buang yang bukan OPEN atau gameKey beda | `liveMarketAbi` |
| Data partai | `sourceRequest(gameRef, lichessBaseUrl)`, `parseLichessJson` / `parsePgn`, `resolve` (node mode) | `@movemarket/shared` |
| Konsensus | `consensusIdenticalAggregation<string>()` atas `encodeConsensusPayload` (`"id:code,..."`) | `ResolveModule` |
| Report | `encodeReport({ gameKey, ids, outcomes })`, `writeReport` dengan `gasConfig.gasLimit` dari config. Throw kalau tx bukan SUCCESS atau receiver revert | `encodeReport` |
| Nilai kembali | string JSON `CreHandlerResult`: `{ gameRef, resolved, skipped, txHash }`; `note` kalau berhenti; `mode: "local-simulation"` dan `note` = payload di target local-simulation | `CreHandlerResult` |

`resolved` = jumlah pasar di report (YES, NO, atau VOID). `skipped` = id di event yang tidak ikut (bukan OPEN, gameKey beda, atau masih PENDING).

## Target

| Target | `mode` | Registry | Dipakai untuk |
|---|---|---|---|
| `local-simulation` | `local-simulation` | `private` | Fetch, resolve, konsensus tanpa report. Jangan pernah dengan `--broadcast` |
| `staging-settings` | `onchain` | `private` (ganti sebelum `--broadcast`) | Simulasi report, `--broadcast` lewat MockKeystoneForwarder |
| `production-settings` | `onchain` | `private` (ganti sebelum deploy) | Deploy DON (setelah Early Access) |

Forwarder dari `cre workflow supported-chains --output json` (10 Okt 2026, org `My Org`): `monad-testnet` selector `2183018362218727504`, mock `0xB9F79d863261869B234c481D1f9A7af84AeAd192`, produksi `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`. Sama dengan `sot/constants.json`.

## Perintah

```bash
cd resolver-workflow
bun install                 # postinstall tidak ada; kalau SDK baru: bunx cre-setup
bun test                    # 15 test: logika murni + handler lewat runtime uji SDK
bun run typecheck
bun run build               # cre workflow build --target local-simulation -> resolver-workflow/binary.wasm (di-gitignore)
```

## Status (10 Okt 2026)

- `bun test` lulus, `tsc --noEmit` bersih, `cre workflow build` sukses (WASM sekitar 4,3 MB; batas simulasi 100 MB / 20 MB terkompresi).
- Smoke `cre workflow simulate` target `local-simulation` dengan tx Monad Testnet acak dan config sementara (alamat bukan nol): WASM jalan di QuickJS, config lolos zod, trigger terdaftar di selector `2183018362218727504`, lalu berhenti dengan `log topic 0 does not match` karena tx itu bukan `ResolutionRequested`. Handler belum pernah jalan di QuickJS dengan event nyata.
- Semua `config.*.json` masih memakai alamat nol, dan `configSchema` sengaja menolaknya. Simulasi gagal di validasi config sampai alamat diisi.

## Langkah tertunda

1. **Deploy `LiveMarket` ke Monad Testnet** (repo `smart-contract/`), forwarder awal = mock `0xB9F79d...`. Isi alamat di `sot/constants.json` lalu di ketiga `config.*.json` (test `logic.test.ts` menagih kecocokannya begitu SOT terisi).
2. **Simulasi dengan tx `requestResolution` nyata**, tunggu bloknya finalized, dari `backend/cre/`:

   ```bash
   # 0. tanpa receiver (wajib pertama)
   cre workflow simulate resolver-workflow --target local-simulation \
     --non-interactive --trigger-index 0 --evm-tx-hash <hash> --evm-event-index 0
   # 1. dry run target onchain, tanpa transaksi
   cre workflow simulate resolver-workflow --target staging-settings \
     --non-interactive --trigger-index 0 --evm-tx-hash <hash> --evm-event-index 0
   # 2. tulis sungguhan lewat MockKeystoneForwarder (butuh langkah 3 dan 4)
   cre workflow simulate resolver-workflow --target staging-settings \
     --non-interactive --trigger-index 0 --evm-tx-hash <hash> --evm-event-index 0 --broadcast
   ```

   Tanpa `CRE_ETH_PRIVATE_KEY`, CLI memakai key default untuk simulasi tulis (terlihat di output). Untuk `--broadcast` isi `CRE_ETH_PRIVATE_KEY` di `backend/cre/.env` sendiri (jangan dibagikan ke agen), wallet di atas 10 MON (SOT 13a).
3. **Early Access**: user menjalankan `cre account access` secara interaktif. Status sekarang: belum aktif.
4. **Registry**: `cre registry list` hanya punya `private` dan `onchain:ethereum-mainnet` (jangan dipakai). Setelah Early Access, ganti `deployment-registry` di `workflow.yaml` (staging dan production) dengan ID registry testnet dari `cre registry list`.
5. **Gas**: `gasLimit` `1000000` masih sementara. Ukur `onReport` batch 8 lewat forwarder dengan `eth_estimateGas`, perbarui `sot/constants.json` `cre.gasLimit` lalu config.
6. Deploy DON (`cre workflow deploy` / `activate`, lalu `setForwarder(0xF8344CFd...)`) hanya setelah langkah 1 sampai 4, dengan konfirmasi user (CRE_WORKFLOW.md bagian 10).
