// Kaizen: seguidores das redes sociais pelo @ público (Instagram, TikTok, YouTube)
// Ações: cron (agendamento) | atualizar (sócio) | testar {rede,handle} (sócio)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (direct) return direct;
  const many = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (many) { try { const o = JSON.parse(many); const v = Object.values(o)[0]; if (typeof v === "string") return v; } catch (_) { return many.split(",")[0]; } }
  return "";
}
const db = createClient(SUPA_URL, serviceKey(), { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function isSocio(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await db.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: ppl } = await db.from("docs").select("id,data").eq("collection", "people");
  const me = (ppl ?? []).find((r: any) => String(r.data?.email || "").toLowerCase() === email);
  return !!me && me.data?.papel === "socio";
}

function abbrev(s: string): number | null {
  const m = s.replace(/\s/g, "").match(/([\d.,]+)([KMB]|mil|mi|bi)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, m[2] ? "." : "").replace(/\.(?=\d{3}(\D|$))/g, m[2] ? "." : ""));
  if (!m[2]) n = Number(m[1].replace(/[.,]/g, ""));
  const k = (m[2] || "").toLowerCase();
  const mult = k === "k" || k === "mil" ? 1e3 : k === "m" || k === "mi" ? 1e6 : k === "b" || k === "bi" ? 1e9 : 1;
  return Math.round(n * mult);
}

async function instagram(h: string) {
  try { return await instagramApi(h); } catch (e1) {
    for (const url of [`https://www.instagram.com/${encodeURIComponent(h)}/`, `https://www.instagram.com/${encodeURIComponent(h)}/?hl=en`]) {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Accept-Language": "en-US,en;q=0.9" } });
      const t = await r.text();
      const m = t.match(/content="([\d.,]+[KMB]?) Followers/i) || t.match(/"edge_followed_by":\{"count":(\d+)\}/);
      if (m) return { n: abbrev(m[1]) ?? 0, nome: (t.match(/<meta property="og:title" content="([^"(]+)/) || [])[1]?.trim() || h, aprox: /[KMB]/i.test(m[1]) };
    }
    throw e1;
  }
}
async function instagramApi(h: string) {
  const r = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(h)}`, { headers: { "User-Agent": "Instagram 309.0.0.40.113 Android", "x-ig-app-id": "936619743392459", "Accept": "application/json" } });
  if (!r.ok) throw new Error(`instagram ${r.status}`);
  const j = await r.json();
  const n = j?.data?.user?.edge_followed_by?.count;
  if (typeof n !== "number") throw new Error("instagram sem número");
  return { n, nome: j.data.user.full_name || h };
}
async function tiktok(h: string) {
  const r = await fetch(`https://www.tiktok.com/@${encodeURIComponent(h)}`, { headers: { "User-Agent": UA, "Accept-Language": "pt-BR,pt;q=0.9" } });
  const t = await r.text();
  const m = t.match(/"followerCount":(\d+)/);
  if (!m) throw new Error(`tiktok ${r.status} sem número`);
  return { n: Number(m[1]), nome: (t.match(/"nickname":"([^"]+)"/) || [])[1] || h };
}
async function youtube(h: string) {
  const r = await fetch(`https://www.youtube.com/@${encodeURIComponent(h.replace(/^@/, ""))}?hl=en&gl=US`, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cookie": "CONSENT=YES+1" } });
  const t = await r.text();
  const m = t.match(/"metadataParts":\[\{"text":\{"content":"[^"]*"\}\},\{"text":\{"content":"([\d.,]+[KMB]?) subscribers"/) || t.match(/([\d.,]+[KMB]?) subscribers/);
  if (!m) throw new Error(`youtube ${r.status} sem número`);
  return { n: abbrev(m[1]) ?? 0, nome: (t.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || h, aprox: /[KMB]/.test(m[1]) };
}
const FETCH: Record<string, (h: string) => Promise<{ n: number; nome: string; aprox?: boolean }>> = { instagram, tiktok, youtube };

const brDay = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function atualizar() {
  const { data: rows } = await db.from("docs").select("id,data").eq("collection", "redes");
  const out: string[] = [];
  for (const r of rows ?? []) {
    const d: any = r.data || {};
    const f = FETCH[d.rede];
    if (!f || !d.handle || d.manual) continue;
    try {
      const v = await f(String(d.handle).replace(/^@/, ""));
      const hist = Array.isArray(d.hist) ? d.hist.filter((x: any) => x.d !== brDay()) : [];
      hist.push({ d: brDay(), n: v.n });
      await db.from("docs").upsert({ collection: "redes", id: r.id, data: { ...d, nome: d.nome || v.nome, n: v.n, aprox: !!v.aprox, hist: hist.slice(-120), at: new Date().toISOString(), erro: null }, updated_at: new Date().toISOString() });
      out.push(`${r.id}:${v.n}`);
    } catch (e) {
      await db.from("docs").upsert({ collection: "redes", id: r.id, data: { ...d, erro: String(e).slice(0, 120), erroEm: new Date().toISOString() }, updated_at: new Date().toISOString() });
      out.push(`${r.id}:erro ${String(e).slice(0, 60)}`);
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "kaizen-social" });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === "cron") return json({ ok: true, out: await atualizar() });
    if (!(await isSocio(req))) return json({ error: "socio" }, 403);
    if (body.action === "atualizar") return json({ ok: true, out: await atualizar() });
    if (body.action === "testar") { const f = FETCH[body.rede]; if (!f) return json({ error: "rede" }, 400); return json({ ok: true, ...(await f(String(body.handle || "").replace(/^@/, ""))) }); }
    return json({ error: "action" }, 400);
  } catch (e) {
    return json({ error: String(e).slice(0, 300) }, 500);
  }
});
