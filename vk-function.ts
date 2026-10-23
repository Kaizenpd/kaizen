// Kaizen: ponte com o VK Metrics (MCP da organização, credencial client_credentials)
// Ações (sócio): status | tools | call {name,args}
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "kaizen-vk", configured: !!(CID && CSEC) });
  try {
    if (!(await isSocio(req))) return json({ error: "socio" }, 403);
    if (!CID || !CSEC) return json({ error: "config" }, 500);
    const body = await req.json().catch(() => ({}));
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
