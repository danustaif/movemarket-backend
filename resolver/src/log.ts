// Log JSON satu baris dengan redaksi. URL RPC/WS bisa memuat API key di path, query, atau userinfo, dan
// muncul di pesan error viem; semua log dan respons yang memuat error lewat redact().
import { SOT } from "@movemarket/shared";

/** Host sumber publik (Lichess) dari SOT: URL-nya tidak rahasia dan berguna untuk diagnosis. */
const PUBLIC_HOSTS = new Set(Object.values(SOT.lichess.sources).map((s) => new URL(s.split(" ").at(-1)!).host));
const URL_RE = /\b((?:https?|wss?):\/\/)(?:[^\s"'@/]*@)?([^\s"'/?#]+)([^\s"']*)/gi;

/** Sisakan skema dan host URL non-publik; path dan query jadi `/***`, userinfo dibuang. */
export const redact = (text: string): string =>
  text.replace(URL_RE, (url, scheme: string, host: string, rest: string) => {
    if (PUBLIC_HOSTS.has(host.toLowerCase())) return url;
    return `${scheme}${host}${rest === "" || rest === "/" ? rest : "/***"}`;
  });

/** JSON dengan bigint sebagai string desimal dan semua string diredaksi. */
export const safeJson = (x: unknown): string =>
  JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? redact(v) : v));

export const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(safeJson({ t: new Date().toISOString(), event, ...data }));
