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
| `resolver/` | Selesai untuk sumber replay dan broadcast: registry, planner, kunci ply, hasil sementara, requester (D17, D18), watcher proposed/finalized (D20), tx queue, runner CRE, faucet, SSE, route HTTP publik dan admin, pemulihan setelah restart. Sumber TV (Could) belum. Paket deploy container: `Dockerfile`, `docker-compose.yml` (bagian Deploy) |
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

## Deploy resolver (container 24 jam)

Image berisi Bun 1.3.14, resolver, proyek `cre/` yang sudah di-build (cache Javy terisi), dan CLI `cre` v1.33.0 (dipin, sha256 diverifikasi dari rilis resmi `smartcontractkit/cre-cli`). Jalan sebagai user `bun` (uid 1000), port 8787 (SOT `resolver.PORT`), `HEALTHCHECK` ke `GET /health`. Tidak ada secret di image: `.env`, `secrets.yaml`, keystore, dan `node_modules` dikecualikan oleh `Dockerfile.dockerignore`.

Build context adalah folder kerja (berisi `source/` dan `backend/` berdampingan) karena image butuh `source/shared` dan `source/sot`:

```bash
# dari folder kerja
docker build -f backend/Dockerfile -t movemarket-resolver .
docker run --rm -p 8787:8787 -e CRE_MODE=off movemarket-resolver   # uji cepat: mode terbatas, /health 200
```

VPS: `backend/docker-compose.yml` (satu service, `restart: unless-stopped`):

```bash
docker compose -f backend/docker-compose.yml up -d --build
```

**Satu instance saja.** Registry partai, pasar, replay, dan klien SSE ada di memori proses; dua instance berarti dua planner dan dua replay yang saling bertabrakan. Restart aman (pemulihan dari `DEPLOY_BLOCK`, RESOLVER_SERVICE.md 2.11). Frontend HTTPS butuh resolver di HTTPS: pasang reverse proxy TLS (Caddy/nginx) di depan port 8787 tanpa buffering untuk SSE `/stream`, lalu `TRUST_PROXY=true`.

### Env

Isi `backend/resolver/.env` di server (dibaca compose lewat `env_file`; jangan commit). Alamat kontrak, `DEPLOY_BLOCK`, dan default lain dibaca dari SOT kalau kosong.

| Nama | Wajib | Catatan |
|---|---|---|
| `RESOLVER_PRIVATE_KEY` | ya | Tanpa ini mode terbatas (transaksi ditolak) |
| `FAUCET_PRIVATE_KEY` | ya | Wallet faucet terpisah |
| `ADMIN_TOKEN` | ya | Tanpa ini `/admin/*` mati |
| `CORS_ORIGIN` | ya | Domain frontend |
| `MONAD_TESTNET_RPC`, `MONAD_TESTNET_WS` | disarankan | RPC sponsor untuk proses 24 jam |
| `CRE_MODE` | | Default `simulate`; `off` kalau resolusi dijalankan di tempat lain |
| `CRE_ETH_PRIVATE_KEY` | untuk `simulate` | Wallet `--broadcast` CLI `cre` (saldo di atas 10 MON, SOT 13a). Runner meneruskan env proses ke `cre` kecuali tiga secret resolver di atas |
| `CRE_API_KEY` | alternatif sesi login | Lihat di bawah |
| `TRUST_PROXY` | | `true` di belakang reverse proxy |

`CRE_PROJECT_DIR` sudah di-set image ke `/app/backend/cre`; jangan di-override.

### Kredensial CLI `cre`

`cre workflow simulate` (termasuk target `local-simulation`) **butuh autentikasi**. Diuji dengan `HOME` kosong dan di dalam container tanpa kredensial: CLI keluar dengan kode 1, `Authentication required: not logged in and no CRE_API_KEY set`. Runner mencatat pesan itu sebagai error `cre simulate exit 1`, jadi pasar tidak final sampai kredensial ada. `cre workflow build` tidak butuh login (dipakai saat build image).

Dua cara, keduanya tanpa memasukkan kredensial ke image:

1. **`CRE_API_KEY`** (paling cocok untuk server): dibuat di app.chain.link, Organization, tab APIs. Syarat: akun sudah disetujui deploy access (`cre account access`). Isi di `.env` server.
2. **Sesi `cre login` khusus server**, di-mount ke `/home/bun/.cre` (CLI menyimpan token di `$HOME/.cre/cre.yaml` dan menulis ulang saat refresh, jadi direktori harus writable oleh uid 1000). `cre login` membuka browser dengan callback `localhost:53682`, jadi lakukan di mesin yang punya browser dengan `HOME` terpisah supaya tidak berbagi refresh token dengan sesi laptop:

   ```bash
   mkdir -p /tmp/cre-server && HOME=/tmp/cre-server ~/.cre/bin/cre login
   # salin /tmp/cre-server/.cre/cre.yaml ke server: backend/.cre-auth/cre.yaml (di-gitignore)
   sudo chown -R 1000:1000 backend/.cre-auth && chmod 700 backend/.cre-auth
   docker compose -f backend/docker-compose.yml restart
   docker exec movemarket-resolver cre whoami   # cek sesi
   ```

   Masa berlaku sesi tidak didokumentasikan; cek `cre whoami` berkala atau pindah ke `CRE_API_KEY` begitu deploy access aktif.

`CRE_ETH_PRIVATE_KEY` dibaca CLI dari `.env` proyek CRE atau env proses (keduanya didukung CLI v1.33.0; `.env` proyek menang). Di container tidak ada `backend/cre/.env`, jadi env proses yang dipakai. Alternatif setara: mount file env read-only ke `/app/backend/cre/.env`.
