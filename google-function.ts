// Kaizen: conectar a conta Google da empresa (Google Agenda + Meet)
// Ações: start (sócio) | callback GET ?code | status | disconnect
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
function serviceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY");
  if (direct) return direct;
  const many = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (many) { try { const o = JSON.parse(many); const v = Object.values(o)[0]; if (typeof v === "string") return v; } catch (_) { return many.split(",")[0]; } }
  return "";
}
const SERVICE = serviceKey();
const db = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const CID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CSECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const APP_URL = Deno.env.get("KAIZEN_URL") ?? "https://kaizen.exposia.com.br/";
const REDIRECT = `${SUPA_URL}/functions/v1/google`;
const SCOPE = "https://www.googleapis.com/auth/calendar.events openid email";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function hmac(s: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(CSECRET + SERVICE.slice(-16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, "");
}
async function isSocio(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await db.auth.getUser(tok);
  const email = data?.user?.email?.toLowerCase();
  if (!email) return null;
  const { data: ppl } = await db.from("docs").select("id,data").eq("collection", "people");
  const me = (ppl ?? []).find((r: any) => String(r.data?.email || "").toLowerCase() === email);
  return me && me.data?.papel === "socio" ? { uid: data!.user!.id, person: me.id } : null;
}
async function setStatus(data: Record<string, unknown>) {
  await db.from("docs").upsert({ collection: "config", id: "google", data, updated_at: new Date().toISOString() });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.has("code")) {
      const [p, sig] = (url.searchParams.get("state") ?? "").split(".");
      if (!p || sig !== (await hmac(p)) || Date.now() > JSON.parse(atob(p)).exp) return Response.redirect(APP_URL + "?g=erro", 302);
      const r = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: url.searchParams.get("code")!, client_id: CID, client_secret: CSECRET, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
      });
      const tok = await r.json().catch(() => ({}));
      if (!r.ok || !tok.refresh_token) return Response.redirect(APP_URL + "?g=erro", 302);
      let email = "";
      try { const pl = JSON.parse(atob(String(tok.id_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); email = pl.email || ""; } catch (_) { /* ok */ }
      await db.from("g_auth").upsert({ id: "org", refresh_token: tok.refresh_token, email, updated_at: new Date().toISOString() });
      await setStatus({ connected: true, email, at: new Date().toISOString() });
      return Response.redirect(APP_URL + "?g=ok", 302);
    }
    if (req.method === "GET") return json({ ok: true, service: "kaizen-google", configured: !!(CID && CSECRET) });
    const body = await req.json().catch(() => ({}));
    const who = await isSocio(req);
    if (!who) return json({ error: "socio" }, 403);
    if (body.action === "start") {
      if (!CID || !CSECRET) return json({ error: "config" }, 500);
      const p = btoa(JSON.stringify({ uid: who.uid, exp: Date.now() + 15 * 60 * 1000 }));
      const q = new URLSearchParams({ client_id: CID, redirect_uri: REDIRECT, response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state: `${p}.${await hmac(p)}` });
      return json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
    }
    if (body.action === "disconnect") {
      await db.from("g_auth").delete().eq("id", "org");
      await setStatus({ connected: false });
      return json({ ok: true });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
