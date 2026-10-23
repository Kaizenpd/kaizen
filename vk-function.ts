// Kaizen: ponte com o VK Metrics (MCP da organização, credencial client_credentials)
// Ações (sócio): status | tools | call {name,args} | sync (também roda pelo agendamento)
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
const CID = (Deno.env.get("VK_CLIENT_ID") ?? "").trim();
const CSEC = (Deno.env.get("VK_CLIENT_SECRET") ?? "").trim();
const BASE = "https://app.vkmetrics.com/api/mcp/v1";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function isSocio(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await db.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return false;
  const { data: ppl } = await db.from("docs").select("id,data").eq("collection", "people");
  const me = (ppl ?? []).find((r: any) => String(r.data?.email || "").toLowerCase() === email);
  return !!me && me.data?.papel === "socio";
}

async function token(): Promise<string> {
  const r = await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: CID, client_secret: CSEC }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}

function parseRpc(text: string, ctype: string) {
  if (ctype.includes("text/event-stream")) {
    const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) { try { const o = JSON.parse(datas[i]); if (o.result || o.error) return o; } catch (_) { /* ok */ } }
    return {};
  }
  try { return JSON.parse(text); } catch (_) { return { raw: text.slice(0, 500) }; }
}

class Mcp {
  sid = ""; n = 0; tok = "";
  async init() {
    this.tok = await token();
    const r = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "kaizen", version: "1.0" } });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }
  async post(body: unknown) {
    const h: Record<string, string> = { "Authorization": `Bearer ${this.tok}`, "Accept": "application/json, text/event-stream", "Content-Type": "application/json" };
    if (this.sid) h["Mcp-Session-Id"] = this.sid;
    const r = await fetch(BASE, { method: "POST", headers: h, body: JSON.stringify(body) });
    const sid = r.headers.get("mcp-session-id"); if (sid) this.sid = sid;
    const text = await r.text();
    return { status: r.status, body: parseRpc(text, r.headers.get("content-type") || "") };
  }
  async rpc(method: string, params: unknown) {
    const r = await this.post({ jsonrpc: "2.0", id: ++this.n, method, params });
    if ((r.body as any).error) throw new Error(`${method}: ${JSON.stringify((r.body as any).error).slice(0, 300)}`);
    return (r.body as any).result ?? r.body;
  }
}

/* ---------- sincronização semanal ---------- */
const pad = (n: number) => String(n).padStart(2, "0");
const isoD = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
function brToday(): Date { const n = new Date(Date.now() - 3 * 3600e3); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); }
function mondayOf(d: Date) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; }
const addD = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const canal = (src: string | null) => !src ? "outros" : src.startsWith("paid_") ? "pago" : src === "organic_whatsapp" ? "comercial" : src.startsWith("organic_") ? "organico" : "outros";
const OK = ["approved", "completed"];

async function sync(weeks = 8) {
  const m = new Mcp(); await m.init();
  const today = brToday(), ws = mondayOf(today);
  const list: { id: string; a: string; b: string; parcial: boolean }[] = [];
  for (let i = weeks; i >= 0; i--) { const a = addD(ws, -7 * i); const b = i === 0 ? today : addD(a, 6); list.push({ id: isoD(a), a: isoD(a), b: isoD(b), parcial: i === 0 }); }
  const queries: unknown[] = [];
  for (const w of list) {
    const f = { date: { operator: "$between", value: [w.a, w.b] } };
    queries.push({ metrics: ["revenue", "purchase_count"], dimensions: ["vk_source", "purchase.status"], filters_json: JSON.stringify({ ...f, "purchase.status": { operator: "$in", value: ["approved", "completed", "refunded", "chargeback"] } }), limit: 500 });
    queries.push({ metrics: ["spend"], filters_json: JSON.stringify(f) });
  }
  const r: any = await m.rpc("tools/call", { name: "vk_analytics_query_batch", arguments: { queries, parallel: true } });
  const txt = (r.content ?? []).map((c: any) => c.text ?? "").join("");
  const res = JSON.parse(txt).results;
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const w = list[i], sales = res[2 * i], sp = res[2 * i + 1];
    if (!sales?.success) { out.push(`${w.id}:erro`); continue; }
    const c: Record<string, number> = { pago: 0, organico: 0, comercial: 0, outros: 0 };
    let fat = 0, n = 0, nPago = 0, nRef = 0;
    for (const row of sales.data ?? []) {
      const st = row["purchase.status"], rev = Number(row.revenue) || 0, cnt = Number(row.purchase_count) || 0;
      if (OK.includes(st)) { fat += rev; n += cnt; c[canal(row.vk_source)] += rev; if (canal(row.vk_source) === "pago") nPago += cnt; }
      else nRef += cnt;
    }
    const invest = sp?.success ? Number(sp.data?.[0]?.spend) || 0 : null;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const v: Record<string, number> = { fat: r2(fat), vendas: n, fat_pago: r2(c.pago), fat_org: r2(c.organico), fat_com: r2(c.comercial), reemb: n + nRef ? r2(nRef / (n + nRef) * 100) : 0, reemb_n: nRef };
    if (n) v.ticket = r2(fat / n);
    if (invest != null && invest > 0) { v.invest = r2(invest); v.roas = r2(fat / invest); if (nPago) v.cpa = r2(invest / nPago); }
    await db.from("docs").upsert({ collection: "semanas", id: w.id, data: { valores: v, parcial: w.parcial, ate: w.b, fonte: "VK Metrics (automático)", at: new Date().toISOString() }, updated_at: new Date().toISOString() });
    out.push(`${w.id}:ok`);
  }
  await db.from("docs").upsert({ collection: "config", id: "vkSync", data: { at: new Date().toISOString(), weeks: out }, updated_at: new Date().toISOString() });
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "kaizen-vk", configured: !!(CID && CSEC) });
  try {
    const body = await req.json().catch(() => ({}));
    if (!CID || !CSEC) return json({ error: "config" }, 500);
    if (body.action === "cron") {
      const { data: last } = await db.from("docs").select("data").eq("collection", "config").eq("id", "vkSync").maybeSingle();
      if (last?.data?.at && Date.now() - new Date(last.data.at).getTime() < 30 * 60e3) return json({ ok: true, skipped: true });
      return json({ ok: true, weeks: await sync(2) });
    }
    if (!(await isSocio(req))) return json({ error: "socio" }, 403);
    if (body.action === "sync") return json({ ok: true, weeks: await sync(Math.min(16, Number(body.weeks) || 8)) });
    const m = new Mcp();
    const info = await m.init();
    if (body.action === "status") return json({ ok: true, server: (info as any)?.serverInfo ?? null });
    if (body.action === "tools") {
      const r: any = await m.rpc("tools/list", {});
      return json({ ok: true, tools: (r.tools ?? []).map((t: any) => ({ name: t.name, description: String(t.description || "").slice(0, 300), input: t.inputSchema })) });
    }
    if (body.action === "call") {
      const r: any = await m.rpc("tools/call", { name: body.name, arguments: body.args || {} });
      const txt = (r.content ?? []).map((c: any) => c.text ?? JSON.stringify(c)).join("\n");
      return json({ ok: true, text: txt.slice(0, 20000), structured: r.structuredContent ?? null });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e).slice(0, 400) }, 500);
  }
});
