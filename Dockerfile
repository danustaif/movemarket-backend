# syntax=docker/dockerfile:1.7
# Resolver service MoveMarket + CLI `cre` untuk CRE_MODE=simulate (ARCHITECTURE.md bagian 9).
# Build context = folder kerja yang berisi source/ dan backend/ berdampingan:
#   docker build -f backend/Dockerfile -t movemarket-resolver .
# Ignore file: backend/Dockerfile.dockerignore (BuildKit membacanya otomatis).
# Secret (RESOLVER_PRIVATE_KEY, FAUCET_PRIVATE_KEY, ADMIN_TOKEN, CRE_ETH_PRIVATE_KEY, CRE_API_KEY) hanya lewat env
# runtime; sesi `cre login` lewat volume di /home/bun/.cre. Tidak ada secret di image atau build arg.

# Bun 1.3.x sama dengan lokal.
FROM oven/bun:1.3.14

# CLI cre dipin (>= SOT cre.cliMin 1.30.0; versi yang dipakai untuk simulate --broadcast lokal).
# Aset dan sha256 dari rilis resmi github.com/smartcontractkit/cre-cli/releases/tag/v1.33.0.
ARG CRE_VERSION=1.33.0
ARG TARGETARCH
ADD https://github.com/smartcontractkit/cre-cli/releases/download/v${CRE_VERSION}/cre_linux_${TARGETARCH}.tar.gz /tmp/cre.tar.gz
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sum=956b2ae2b764673f34f3101b2beafd40377b851b56a39f7e49f156175f8a897a ;; \
      arm64) sum=bdfa877910dcf9d97e66e07f0a2bc228fa1a97b6c1becd7cad323c9bd70bc655 ;; \
      *) echo "arsitektur $TARGETARCH tidak didukung" >&2; exit 1 ;; \
    esac; \
    echo "$sum  /tmp/cre.tar.gz" | sha256sum -c -; \
    mkdir /tmp/cre && tar -xzf /tmp/cre.tar.gz -C /tmp/cre; \
    install -m 0755 "$(find /tmp/cre -type f -name 'cre*' | head -n1)" /usr/local/bin/cre; \
    rm -rf /tmp/cre /tmp/cre.tar.gz; \
    mkdir -p -m 0700 /home/bun/.cre && chown bun:bun /home/bun/.cre

WORKDIR /app
# Tata letak sama dengan folder kerja supaya `file:../../source/shared` dan `../../sot/*.json` tetap valid.
COPY source/shared source/shared
COPY source/sot source/sot
COPY backend/resolver backend/resolver
COPY --chown=bun:bun backend/cre backend/cre

# shared perlu node_modules sendiri (viem): Bun me-resolve paket file: ke path aslinya.
# Workflow butuh devDependencies (typescript) karena `cre workflow simulate` men-typecheck sebelum kompilasi.
# File lokal ada yang 0600; buat bisa dibaca user bun.
RUN chmod -R a+rX /app \
 && cd source/shared && bun install --frozen-lockfile --production \
 && cd /app/backend/resolver && bun install --frozen-lockfile --production
USER bun
ENV HOME=/home/bun
# Build sekali saat image dibuat: memastikan workflow terkompilasi dan mengisi cache Javy di ~/.cache
# (build tidak butuh login; simulate butuh, lihat backend/README.md bagian Deploy).
RUN cd backend/cre/resolver-workflow && bun install --frozen-lockfile \
 && cd .. && cre workflow build ./resolver-workflow --target local-simulation --non-interactive

WORKDIR /app/backend/resolver
ENV NODE_ENV=production \
    CRE_PROJECT_DIR=/app/backend/cre
# Port default = SOT resolver.PORT; healthcheck membacanya dari SOT kalau PORT tidak di-set.
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const p=process.env.PORT||require('/app/source/sot/constants.json').resolver.PORT;fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "src/index.ts"]
