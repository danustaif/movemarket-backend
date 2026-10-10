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
| `resolver/` | Selesai untuk sumber replay dan broadcast: registry, planner, kunci ply, hasil sementara, requester (D17, D18), watcher proposed/finalized (D20), tx queue, runner CRE (`simulate` lewat CLI, `mock` tanpa CLI, D23), faucet, SSE, route HTTP publik dan admin, pemulihan setelah restart. Sumber TV (Could) belum. Paket deploy container: `Dockerfile`, `docker-compose.yml` (bagian Deploy) |
| `cre/` | Proyek dari `cre init`, handler `ResolutionRequested` sampai report `onReport`, build WASM lulus. Simulasi dengan tx nyata menunggu `LiveMarket` di-deploy. Detail: `cre/README.md` |
| `indexer/` | Proyek `envio@3.0.0-alpha.21` dari perintah init SOT: config Monad Testnet, handler INDEXER.md bagian 3, test mock DB lulus. Diverifikasi lokal terhadap Monad Testnet (pasar 1-8 cocok dengan on-chain). Deploy Envio Cloud belum (butuh login user). Detail: `indexer/README.md` |

Kontrak antarmuka modul resolver ada di `resolver/src/contracts.ts`; API HTTP dan SSE di `@movemarket/shared` (`ResolverRoutes`, `SseEvents`).

Uji integrasi lokal (anvil + kontrak + MockForwarder + resolver, sumber replay dari fixture; plus runner `CRE_MODE=mock` lewat GatedForwarder dan, sebagai cadangan, bytecode MockKeystoneForwarder asli) ada di `resolver/test/integration/`; lihat Perintah.

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

## VPS produksi (Tencent, aktif sejak 10-11 Oktober 2026)

| Layanan | URL publik | Di VPS |
|---|---|---|
| Resolver (REST + SSE) | `https://api.43-133-151-182.sslip.io` | container `movemarket-resolver`, `127.0.0.1:8787`, `CRE_MODE=mock` (D23) lewat GatedForwarder (D24) |
| Indexer GraphQL (read-only, role `public`) | `https://indexer.43-133-151-182.sslip.io/v1/graphql` | `backend/indexer/docker-compose.yml`: Postgres + Hasura (`127.0.0.1:8080`) + `movemarket-indexer` (`config.selfhost.yaml`, sumber RPC) |
| TLS | Caddy (systemd), `backend/deploy/Caddyfile` di `/etc/caddy/Caddyfile` | sertifikat Let's Encrypt otomatis; port 80 dan 443 harus terbuka di security group |

`sslip.io` memetakan nama ke IP sehingga HTTPS jalan tanpa domain. Saat domain final ada, ganti host di Caddyfile (env `API_HOST`, `INDEXER_HOST`) dan reload Caddy.

Tata letak di VPS: `~/movemarket/{source,smart-contract,fe,backend}` (clone repo publik). Secret hanya di VPS, permission 600, tidak di git: `backend/resolver/.env`, `backend/docker-compose.vps.yml` (override: `CRE_MODE=mock`, `TRUST_PROXY`, `ADMIN_TOKEN`, `CORS_ORIGIN`), `backend/indexer/.env` (password Postgres dan secret admin Hasura), `~/.movemarket-admin-token`.

Operasi (di VPS, dari `~/movemarket`):

```bash
# update kode lalu build ulang
for r in source smart-contract fe backend; do git -C $r pull --ff-only; done
sudo docker compose -f backend/docker-compose.yml -f backend/docker-compose.vps.yml up -d --build      # resolver
(cd backend/indexer && sudo docker compose up -d --build)                                              # indexer

# status dan log
sudo docker ps
sudo docker logs -f movemarket-resolver
sudo docker logs -f movemarket-indexer
curl -s localhost:8080/v1/graphql -H 'content-type: application/json' -d '{"query":"{ _meta { progressBlock sourceBlock isReady } }"}'

# admin resolver (token di ~/.movemarket-admin-token)
curl -s -X POST localhost:8787/admin/replay -H "authorization: Bearer $(cat ~/.movemarket-admin-token)" \
  -H 'content-type: application/json' -d '{"gameId":"ymG9hwyh"}'
```

Satu instance resolver saja (state di memori). Build di VPS lambat (2 vCPU, RAM 2 GB + swap); Docker Hub dan registry npm bisa time out sesekali, cukup ulangi build.

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
| `CRE_MODE` | | Default `simulate`. **VPS sampai Early Access: `mock`** (tanpa CLI dan kredensial `cre`, lihat di bawah). `off` kalau resolusi dijalankan di tempat lain |
| `CRE_ETH_PRIVATE_KEY` | untuk `simulate` | Wallet `--broadcast` CLI `cre` (saldo di atas 10 MON, SOT 13a). Runner meneruskan env proses ke `cre` kecuali tiga secret resolver di atas |
| `CRE_API_KEY` | alternatif sesi login, untuk `simulate` | Lihat di bawah |
| `TRUST_PROXY` | | `true` di belakang reverse proxy |

`CRE_PROJECT_DIR` sudah di-set image ke `/app/backend/cre`; jangan di-override.

### Sampai Early Access: `CRE_MODE=mock`

CLI `cre` di container butuh login atau `CRE_API_KEY`, dan keduanya belum tersedia. Supaya pasar ber-stake tetap selesai, set `CRE_MODE=mock` (SOT D23): resolver menjalankan langkah handler workflow yang sama (`getMarkets` di blok finalized, export Lichess, `resolve()`, payload) dengan fungsi dari `@movemarket/shared`, lalu memanggil `report()` di forwarder mock dengan wallet resolver lewat antrian transaksi yang sama, gas `cre.gasLimit`. Tidak perlu `CRE_ETH_PRIVATE_KEY`, `CRE_API_KEY`, atau sesi `cre login`. Spesifikasi: `source/docs/RESOLVER_SERVICE.md` 2.7a.

- Forwarder (SOT D24): `GatedForwarder` MoveMarket (`addresses.creGatedForwarder` di SOT), yang hanya menerima `report()` dari wallet resolver (`operator`). Selama alamat itu `null` (belum di-deploy), resolver memakai MockKeystoneForwarder Chainlink `0xB9F79d...`, yang permissionless: siapa pun bisa memanggil `report()` selama `LiveMarket` memakainya. Deploy dan `setForwarder`: `smart-contract/DEPLOY.md` bagian i. `RESOLVER_PRIVATE_KEY` harus wallet `operator`.
- Saat start dan sebelum setiap report, resolver membaca `LiveMarket.forwarder()`. Kalau beda dengan forwarder mock, log `cre_forwarder_mismatch` dan report tidak dikirim (`cre_run_failed` berisi `cre_forwarder_mismatch`). Log `cre_forwarder` saat start berarti cocok.
- Hanya testnet. Bukan konsensus multi-node: satu proses, satu fetch export, dipercaya seperti resolver.
- Bukti bounty CRE tetap dari `cre workflow simulate --broadcast` (tx report `0xb9ee...13c5`), bukan dari mode ini.
- Log `cre_done` berisi `note: "mock-cre"`; metadata report memakai nama workflow `mock-cre` sehingga report mock bisa dibedakan on-chain dari report CLI.
- Saat Early Access aktif: deploy workflow, `setForwarder(KeystoneForwarder)`, lalu `CRE_MODE=don`. Mode mock berhenti mengirim begitu forwarder diganti (`cre_forwarder_mismatch`). Sama untuk demo `simulate --broadcast` (forwarder sementara ke MockKeystoneForwarder): kembalikan ke GatedForwarder setelahnya.

### Kredensial CLI `cre` (hanya `CRE_MODE=simulate`)

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
