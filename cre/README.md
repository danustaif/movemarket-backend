# backend/cre: workflow `resolver-workflow`

Proyek CRE **belum dibuat** dan sengaja tidak ditulis manual. Buat dengan `cre init` (guardrail `chainlink-cre-skill`), langkah lengkap di `../../source/docs/CRE_WORKFLOW.md` bagian 2:

```bash
cre login && cre whoami && cre registry list       # ambil ID registry asli
cre init --non-interactive --project-name movemarket-cre \
  --deployment-registry <ID> --workflow-name resolver-workflow \
  --template hello-world-ts --rpc-url monad-testnet=<RPC>
```

## Kontrak workflow

| Sisi | Kontrak | Sumber tipe |
|---|---|---|
| Trigger | EVM log `ResolutionRequested(bytes32 indexed gameKey, string gameRef, uint256[] ids)` dari `LiveMarket`, chain `monad-testnet`, confidence finalized | `liveMarketAbi` di `@movemarket/shared` |
| Baca kontrak | `getMarkets(ids)` di `LAST_FINALIZED_BLOCK_NUMBER`, buang yang bukan OPEN atau gameKey beda | `liveMarketAbi` |
| Data partai | `sourceRequest(gameRef)` lalu `parseLichessJson` / `parsePgn`, `resolve` | `ResolveModule` di `@movemarket/shared` |
| Konsensus | `consensusIdenticalAggregation<string>()` atas `encodeConsensusPayload` (`"id:code,..."`) | `ResolveModule` |
| Report | `abi.encode(bytes32 gameKey, uint256[] ids, uint8[] outcomes)`, maks `maxMarketsPerReport` (8) | `encodeReport` / `ResolutionReport` |
| Penerima | `LiveMarket.onReport` lewat MockKeystoneForwarder (simulasi) atau KeystoneForwarder (DON) | `smart-contract/src/interfaces/ILiveMarket.sol` |
| Config | `config.<target>.json` | `CreWorkflowConfig` |
| Nilai kembali handler | string JSON, dibaca `CreRunner` di resolver | `CreHandlerResult` |

Workflow berjalan di QuickJS/WASM: hanya impor `@movemarket/shared` (tanpa API Node). Kalau build gagal me-resolve paket lokal, salin `source/shared/src/*.ts` ke `resolver-workflow/shared/` lewat script, jangan edit salinan.
