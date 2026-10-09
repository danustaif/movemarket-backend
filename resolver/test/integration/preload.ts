// Preload KHUSUS uji integrasi: `bun --preload test/integration/preload.ts src/index.ts`.
// Dijalankan sebelum src/index.ts di proses resolver anak, tanpa mengubah kode produksi:
// 1. fetch export e9SJcXpJ dijawab dari fixture lokal. Fixture itu bullet, padahal replay hanya menerima
//    classical/rapid, jadi speed ditimpa "rapid" (resolve() hanya membaca langkah, bukan speed).
//    Host selain loopback ditolak dan dicatat `blocked_network`, jadi test tidak pernah keluar jaringan.
// 2. SOT gas.limits yang masih null diisi dari MM_TEST_GAS_LIMITS (hasil eth_estimateGas di anvil).
//    ponytail: memutasi objek GAS_LIMITS milik modul shared; ganti dengan parameter bootstrap kalau
//    index.ts kelak diekspor sebagai fungsi.
import { GAS_LIMITS } from "@movemarket/shared";
import { FIXTURES } from "../helpers.ts";

const FIXTURE = new URL("game-export.finished-mate.json", FIXTURES);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

Object.assign(GAS_LIMITS, JSON.parse(process.env.MM_TEST_GAS_LIMITS ?? "{}"));

const realFetch = globalThis.fetch;
const stub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (LOOPBACK.has(url.hostname)) return realFetch(input, init);
  if (url.hostname === "lichess.org" && url.pathname === "/game/export/e9SJcXpJ") {
    const json = await Bun.file(FIXTURE).json();
    json.speed = "rapid";
    return Response.json(json);
  }
  console.log(JSON.stringify({ event: "blocked_network", url: url.origin + url.pathname }));
  throw new Error(`uji integrasi: akses jaringan ke ${url.hostname} ditolak`);
};
globalThis.fetch = Object.assign(stub, { preconnect: realFetch.preconnect });
