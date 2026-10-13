# Indexer Envio self-host (VPS). Pola dari enviodev/local-docker-example, disesuaikan:
# pnpm 11 (lockfile proyek), tanpa folder abis (ABI event inline di config), config self-host (HyperSync + RPC cadangan; token ENVIO_API_TOKEN dari compose saat run).
FROM node:24-slim

# psql dipakai envio untuk dump/restore cache efek awal. ca-certificates: klien HyperSync (Rust) membaca CA sistem;
# image slim tidak membawanya, jadi TLS ke 10143.hypersync.xyz gagal "UnknownIssuer" dan indexer jatuh ke RPC cadangan.
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@11.6.0

WORKDIR /envio-indexer
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY config.yaml config.selfhost.yaml schema.graphql tsconfig.json ./
COPY src ./src
ENV CONFIG_FILE=config.selfhost.yaml
# Codegen memasang dependensi generated/ (rescript, dll.) lalu meng-compile ReScript. Tanpa pnpm-workspace.yaml
# sendiri, pnpm 11 memperlakukan generated/ sebagai bagian workspace root dan tidak memasang apa pun
# ("Already up to date", lalu `rescript` not found). Jadi: codegen pertama membuat generated/ (boleh gagal di
# langkah rescript), salin file workspace (allowBuilds) ke generated/, pasang dependensinya, lalu codegen ulang.
RUN pnpm envio codegen --config config.selfhost.yaml || true
RUN cp pnpm-workspace.yaml generated/pnpm-workspace.yaml && cd generated && pnpm install
RUN pnpm envio codegen --config config.selfhost.yaml && test -f generated/src/Index.res.mjs

CMD ["sh", "-c", "pnpm envio start --config ${CONFIG_FILE}"]
