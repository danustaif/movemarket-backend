// Satu koneksi stream panjang per sumber Lichess (SOT lichess.rateLimit): jangan polling,
// reconnect backoff 1, 2, 4, ... maks 60 s, HTTP 429 tunggu 60 s.
const MAX_BACKOFF_MS = 60_000;
const RATE_LIMIT_MS = 60_000;

export interface StreamOpts {
  signal: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** URL dari string SOT `GET https://...{var}...`. */
export const sourceUrl = (source: string, vars: Record<string, string>) =>
  source.replace(/^GET\s+/, "").replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ""));

/** Kirim teks hasil decode per potongan sampai signal abort. `onConnect` dipanggil tiap sambungan baru. */
export async function streamText(url: string, onText: (text: string) => void, o: StreamOpts & { onConnect?: () => void }) {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  let backoff = 1000;
  while (!o.signal.aborted) {
    try {
      const res = await f(url, { signal: o.signal });
      if (res.status === 429) {
        o.log?.("lichess_429", { url });
        await sleep(RATE_LIMIT_MS);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
      o.onConnect?.();
      const decoder = new TextDecoder();
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) onText(decoder.decode(chunk, { stream: true }));
      o.log?.("stream_end", { url });
    } catch (err) {
      if (o.signal.aborted) return;
      o.log?.("stream_error", { url, err: String(err) });
    }
    if (o.signal.aborted) return;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
