import { describe, expect, test } from "bun:test";
import { createSseHub } from "../../src/sse/hub.ts";

async function read(res: Response, ms = 30): Promise<string> {
  const reader = res.body!.getReader();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!r || r.done) break;
    text += new TextDecoder().decode(r.value);
  }
  reader.releaseLock();
  return text;
}

describe("SseHub", () => {
  test("filter ?gameRef=, event tanpa gameRef (ping) ke semua, hitung penonton", async () => {
    const hub = createSseHub({ pingSec: 0 });
    const all = hub.handle(new Request("http://x/stream"));
    const one = hub.handle(new Request("http://x/stream?gameRef=lichess%3Agame%3AAAAAAAAA"));
    expect(all.headers.get("content-type")).toBe("text/event-stream");
    expect(hub.viewers()).toBe(2);

    hub.publish("replay_starting", { gameRef: "lichess:game:BBBBBBBB" });
    hub.publish("game_end", { gameRef: "lichess:game:AAAAAAAA", result: "1-0" });
    hub.publish("ping", {});

    const a = await read(all), b = await read(one);
    expect(a).toContain('event: replay_starting\ndata: {"gameRef":"lichess:game:BBBBBBBB"}\n\n');
    expect(a).toContain("event: game_end\n");
    expect(b).not.toContain("replay_starting");
    expect(b).toContain('event: game_end\ndata: {"gameRef":"lichess:game:AAAAAAAA","result":"1-0"}\n\n');
    expect(b).toContain("event: ping\ndata: {}\n\n");

    await all.body!.cancel();
    expect(hub.viewers()).toBe(1);
  });

  test("ping berkala", async () => {
    const hub = createSseHub({ pingSec: 0.01 });
    const res = hub.handle(new Request("http://x/stream"));
    expect(await read(res, 40)).toContain("event: ping");
    hub.close();
  });
});
