// Aplikasi Hono: CORS dari CORS_ORIGIN, route publik di /, passkey backup di /vault, route admin di /admin.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { log } from "./log.ts";
import { adminRoutes, type AdminActions } from "./routes/admin.ts";
import { apiError, publicRoutes, type PublicDeps } from "./routes/public.ts";
import { vaultRoutes, type VaultDeps } from "./routes/vault.ts";

export interface AppDeps extends PublicDeps {
  corsOrigin: string;
  adminToken: string | undefined;
  admin: AdminActions;
  /** Passkey backup (SOT D27). */
  vault: VaultDeps;
}

export function createApp(d: AppDeps): Hono {
  const origins = d.corsOrigin.split(",").map((s) => s.trim());
  const app = new Hono();
  app.use("*", cors({
    origin: origins.includes("*") ? "*" : origins,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }));
  app.route("/admin", adminRoutes(d.adminToken, d.admin));
  app.route("/vault", vaultRoutes(d.vault));
  app.route("/", publicRoutes(d));
  app.notFound((c) => apiError(c, 404, "not found"));
  app.onError((err, c) => {
    log("http_error", { path: c.req.path, err: String(err) });
    return apiError(c, 500, "internal error");
  });
  return app;
}
