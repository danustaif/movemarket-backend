// GET /stream[?gameRef=] (SOT bagian 11). Event tanpa gameRef (ping) dikirim ke semua klien.
import { SOT, type SseEvents } from "@movemarket/shared";
import type { SseHub } from "../contracts.ts";

interface Client { gameRef: string | null; ctrl: ReadableStreamDefaultController<Uint8Array> }

const enc = new TextEncoder();

export function createSseHub(o: { pingSec?: number } = {}): SseHub & { close(): void } {
  const clients = new Set<Client>();
  const pingSec = o.pingSec ?? SOT.resolver.SSE_PING_SEC;

  const publish = <E extends keyof SseEvents>(event: E, data: SseEvents[E]) => {
    const gameRef = (data as { gameRef?: string }).gameRef;
    const chunk = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of clients) {
      if (c.gameRef && gameRef && c.gameRef !== gameRef) continue;
      try { c.ctrl.enqueue(chunk); } catch { clients.delete(c); }
    }
  };

  const timer = pingSec > 0 ? setInterval(() => publish("ping", {}), pingSec * 1000) : undefined;

  return {
    publish,
    viewers: () => clients.size,
    close: () => clearInterval(timer),
    handle(req) {
      const gameRef = new URL(req.url).searchParams.get("gameRef");
      let client: Client;
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          client = { gameRef, ctrl };
          clients.add(client);
          ctrl.enqueue(enc.encode(": connected\n\n"));
        },
        cancel() { clients.delete(client); },
      });
      req.signal?.addEventListener("abort", () => clients.delete(client));
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    },
  };
}
