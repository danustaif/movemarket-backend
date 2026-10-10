# Indexer Envio self-host (VPS). Pola dari enviodev/local-docker-example, disesuaikan:
# pnpm 11 (lockfile proyek), tanpa folder abis (ABI event inline di config), config self-host (RPC, tanpa token HyperSync).
FROM node:24-slim

# psql dipakai envio untuk dump/restore cache efek awal.
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client && \
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
RUN pnpm envio codegen --config config.selfhost.yaml

CMD ["sh", "-c", "pnpm envio start --config ${CONFIG_FILE}"]
