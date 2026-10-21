// Kaizen -> Slack: resumo de cada pessoa (botão) e resumo automático da manhã
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
const HOOK = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const APP_URL = Deno.env.get("KAIZEN_URL") ?? "https://kaizen.exposia.com.br/";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function post(text: string) {
  const r = await fetch(HOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(`slack ${r.status} ${await r.text()}`);
}
async function col(c: string) {
  const { data } = await db.from("docs").select("id,data").eq("collection", c);
  return (data ?? []) as { id: string; data: any }[];
}
const today = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
function weekStart(ds: string) { const d = new Date(ds + "T12:00:00Z"); const k = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); }
function occurs(t: any, ds: string) {
  if (!t.start) return false;
  if (!t.rec) return t.start <= ds && (t.end && t.end >= t.start ? t.end : t.start) >= ds;
  if (ds < t.start) return false;
  const d = new Date(ds + "T12:00:00Z"), s0 = new Date(t.start + "T12:00:00Z");
  if (t.rec === "weekdays") return d.getUTCDay() > 0 && d.getUTCDay() < 6;
  if (t.rec === "weekly") return d.getUTCDay() === s0.getUTCDay();
  if (t.rec === "monthly") return d.getUTCDate() === s0.getUTCDate();
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: true, service: "kaizen-slack", configured: !!HOOK });
  try {
    const body = await req.json().catch(() => ({}));
    if (!HOOK) return json({ ok: false, error: "config" });

    if (body.action === "daily") {
      const td = today(), d = new Date(td + "T12:00:00Z").getUTCDay();
      if (d === 0 || d === 6) return json({ ok: true, skipped: "fim de semana" });
      const cfg = (await col("config")).find((r) => r.id === "slackDaily")?.data || {};
      if (cfg.last === td && !body.force) return json({ ok: true, skipped: "já enviado" });
      const people = (await col("people")).filter((p) => !p.data?.off);
      const tasks = (await col("tasks")).map((r) => r.data);
      const negs = (await col("inegociaveis")).filter((r) => r.data?.week === weekStart(td));
      let txt = `:sunrise: *Bom dia, time! Kaizen de hoje (${td.slice(8, 10)}/${td.slice(5, 7)})*\n`;
      const meets = tasks.filter((t) => t.meeting && occurs(t, td)).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
      if (meets.length) txt += `\n:calendar: *Reuniões*\n${meets.map((t) => `• ${t.time} ${t.title}`).join("\n")}\n`;
      for (const p of people) {
        const mine = tasks.filter((t) => !t.meeting && t.owner === p.id && t.status !== "done" && t.start && t.start <= td && (t.end || t.start) >= td);
        const late = tasks.filter((t) => !t.meeting && !t.rec && t.owner === p.id && t.status !== "done" && t.start && (t.end || t.start) < td);
        const ng = negs.find((n) => n.data.person === p.id)?.data?.items || [];
        if (!mine.length && !late.length && !ng.length) continue;
        txt += `\n*${p.data.name}*\n`;
        if (mine.length) txt += mine.map((t) => `• ${t.time ? t.time + " " : ""}${t.title}`).join("\n") + "\n";
        if (late.length) txt += `:warning: ${late.length} atrasada${late.length > 1 ? "s" : ""}\n`;
        if (ng.length) txt += `_Inegociáveis da semana: ${ng.filter((i: any) => i.done).length}/${ng.length}_\n`;
      }
      txt += `\n<${APP_URL}|Abrir o Kaizen>`;
      await post(txt);
      await db.from("docs").upsert({ collection: "config", id: "slackDaily", data: { ...cfg, last: td }, updated_at: new Date().toISOString() });
      return json({ ok: true });
    }

    if (body.action === "send") {
      const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: u, error } = await db.auth.getUser(tok);
      if (error || !u?.user) return json({ error: "login" }, 401);
      const text = String(body.text || "").slice(0, 3000);
      if (!text) return json({ error: "texto" }, 400);
      await post(text.replace(/^\*Kaizen ·/, ":memo: *Kaizen ·"));
      return json({ ok: true });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
