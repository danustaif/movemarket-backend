// Route admin (RESOLVER_SERVICE.md 3.2). Wajib header Authorization: Bearer <ADMIN_TOKEN>.
import type { TrackBody } from "@movemarket/shared";
import { Hono, type Context } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";
import { z } from "zod";
import { log, safeJson } from "../log.ts";
import { apiError } from "./public.ts";

export interface AdminActions {
  /** Mulai melacak; kembalikan gameRef partai di sumber itu. */
  track(body: TrackBody): Promise<string[]>;
  untrack(gameRef: string): void;
  replay(gameId: string, plyIntervalSec?: number): Promise<string>;
  void(ids: bigint[]): Promise<Hex>;
  state(): unknown;
}

const trackSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("broadcast"), roundId: z.string().regex(/^[A-Za-z0-9]{8}$/) }),
  z.object({ source: z.literal("tv"), channel: z.string().min(1) }),
]);
const untrackSchema = z.object({ gameRef: z.string().min(1) });
const replaySchema = z.object({ gameId: z.string().regex(/^[A-Za-z0-9]{8}$/), plyIntervalSec: z.number().int().positive().optional() });
const voidSchema = z.object({ marketIds: z.array(z.string().regex(/^\d+$/)).min(1) });

const digest = (s: string) => createHash("sha256").update(s).digest();

/** adminToken undefined: semua route admin 401. */
export function adminRoutes(adminToken: string | undefined, a: AdminActions): Hono {
  const app = new Hono();
  const expected = adminToken ? digest(adminToken) : null;

  app.use("*", async (c, next) => {
    const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!expected || !timingSafeEqual(digest(given), expected)) return apiError(c, 401, "unauthorized");
    await next();
  });

  // Validasi body dengan zod; 400 kalau tidak cocok. Error aksi jadi 502 generik (pesan error bisa memuat
  // URL RPC dengan API key); detailnya di log yang sudah diredaksi.
  const handle = <S extends z.ZodType>(schema: S, fn: (body: z.infer<S>) => Promise<unknown> | unknown) =>
    async (c: Context) => {
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return apiError(c, 400, "body tidak valid");
      try {
        return c.json(await fn(parsed.data) as object);
      } catch (err) {
        log("admin_failed", { path: c.req.path, err: String(err) });
        return apiError(c, 502, "aksi admin gagal, lihat log resolver");
      }
    };

  app.post("/track", handle(trackSchema, async (b) => ({ gameRefs: await a.track(b) })));
  app.post("/untrack", handle(untrackSchema, (b) => { a.untrack(b.gameRef); return { ok: true }; }));
  app.post("/replay", handle(replaySchema, async (b) => ({ gameRef: await a.replay(b.gameId, b.plyIntervalSec) })));
  app.post("/void", handle(voidSchema, async (b) => ({ txHash: await a.void(b.marketIds.map(BigInt)) })));
  app.get("/state", (c) => c.body(safeJson(a.state()), 200, { "content-type": "application/json" }));

  return app;
}
