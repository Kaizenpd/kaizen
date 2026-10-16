// Kaizen: convites de reunião por e-mail (.ics) via Resend
// Ações: push {id} | cancel {id, task}
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
const RESEND = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("KAIZEN_FROM") ?? "Kaizen <kaizen@exposia.com.br>";
const FROM_ADDR = (FROM.match(/<([^>]+)>/) ?? [, FROM])[1]!;
const APP_URL = Deno.env.get("KAIZEN_URL") ?? "https://kaizen.exposia.com.br/";
const NAMES: Record<string, string> = { gabriel: "Gabriel", matheus: "Matheus", nicolas: "Nicholas", joao: "João", lucas: "Lucas", time: "Time todo" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function getDoc(col: string, id: string) {
  const { data } = await db.from("docs").select("data").eq("collection", col).eq("id", id).maybeSingle();
  return data?.data ?? null;
}
async function putDoc(col: string, id: string, data: unknown) {
  const { error } = await db.from("docs").upsert({ collection: col, id, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/* pessoa -> e-mail, a partir dos logins e da tabela de membros */
async function people(): Promise<Map<string, string>> {
  const { data: mem } = await db.from("docs").select("id,data").eq("collection", "members");
  const byUid = new Map((mem ?? []).map((r: any) => [r.id, r.data?.person]));
  const out = new Map<string, string>();
  let page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) break;
    for (const u of data.users) { const p = byUid.get(u.id); if (p && u.email) out.set(p, u.email.toLowerCase()); }
    if (data.users.length < 200) break;
    page++;
  }
  return out;
}

/* ---------- iCalendar ---------- */
const esc = (s: string) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 74) return line;
  const out: string[] = []; let cur = "", n = 0;
  for (const ch of line) { const b = new TextEncoder().encode(ch).length; if (n + b > 73) { out.push(cur); cur = " "; n = 1; } cur += ch; n += b; }
  out.push(cur); return out.join("\r\n");
}
const pad = (n: number) => String(n).padStart(2, "0");
function local(date: string, time: string, addMin = 0) {
  const [h, m] = (time || "09:00").split(":").map(Number);
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m + addMin));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
}
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
function rrule(t: any) {
  if (t.rec === "weekdays") return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  if (t.rec === "weekly") return "RRULE:FREQ=WEEKLY";
  if (t.rec === "monthly") return "RRULE:FREQ=MONTHLY";
  return "";
}
function ics(t: any, id: string, seq: number, to: string[], method: "REQUEST" | "CANCEL") {
  const desc = [t.notes || "", t.call ? `Link da chamada: ${t.call}` : "", `Marcada no Kaizen: ${APP_URL}`].filter(Boolean).join("\n\n");
  const L = [
    "BEGIN:VCALENDAR", "PRODID:-//Kaizen//Convites//PT-BR", "VERSION:2.0", "CALSCALE:GREGORIAN", `METHOD:${method}`,
    "BEGIN:VTIMEZONE", "TZID:America/Sao_Paulo", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:-0300", "TZOFFSETTO:-0300", "TZNAME:-03", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:kaizen-${id}@${FROM_ADDR.split("@")[1] || "kaizen"}`,
    `SEQUENCE:${seq}`,
    `DTSTAMP:${stamp()}`,
    `DTSTART;TZID=America/Sao_Paulo:${local(t.start, t.time)}`,
    `DTEND;TZID=America/Sao_Paulo:${local(t.start, t.time, Number(t.dur) || 60)}`,
    rrule(t),
    `SUMMARY:${esc(t.title || "Reunião")}`,
    desc ? `DESCRIPTION:${esc(desc)}` : "",
    t.call ? `LOCATION:${esc(t.call)}` : "",
    t.call ? `URL:${t.call}` : "",
    `ORGANIZER;CN=Kaizen:mailto:${FROM_ADDR}`,
    ...to.map((e) => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${e}`),
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    ...(method === "REQUEST" ? ["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Lembrete", "TRIGGER:-PT10M", "END:VALARM"] : []),
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return L.map(fold).join("\r\n") + "\r\n";
}
const b64 = (s: string) => { const u = new TextEncoder().encode(s); let bin = ""; u.forEach((b) => bin += String.fromCharCode(b)); return btoa(bin); };

const REC_TXT: Record<string, string> = { weekdays: "todo dia útil", weekly: "toda semana", monthly: "todo mês" };
const WD = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
function when(t: any) {
  const d = new Date(Date.UTC(+t.start.slice(0, 4), +t.start.slice(5, 7) - 1, +t.start.slice(8, 10)));
  const base = `${WD[d.getUTCDay()]}, ${t.start.slice(8, 10)}/${t.start.slice(5, 7)} às ${t.time}`;
  return t.rec ? `${base} · repete ${REC_TXT[t.rec]}` : base;
}
const h = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function send(to: string[], t: any, id: string, seq: number, kind: "novo" | "atualizado" | "cancelado") {
  if (!to.length) return;
  const method = kind === "cancelado" ? "CANCEL" : "REQUEST";
  const prefix = kind === "novo" ? "Convite" : kind === "atualizado" ? "Atualizado" : "Cancelado";
  const subject = `${prefix}: ${t.title} · ${when(t)}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0b1f17">
  <div style="background:#052e22;color:#fff;padding:18px 22px;border-radius:14px 14px 0 0"><b style="font-size:18px">改 Kaizen</b><div style="color:#a7f3d0;font-size:13px">Central do time</div></div>
  <div style="border:1px solid #d1e7dd;border-top:0;padding:20px 22px;border-radius:0 0 14px 14px">
  <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:${kind === "cancelado" ? "#b91c1c" : "#059669"};font-weight:700">${kind === "novo" ? "Nova reunião" : kind === "atualizado" ? "Reunião atualizada" : "Reunião cancelada"}</div>
  <h2 style="margin:6px 0 4px;font-size:22px">${h(t.title)}</h2>
  <p style="margin:0 0 14px;font-size:15px">${h(when(t))} · ${Number(t.dur) || 60} min</p>
  ${t.call && kind !== "cancelado" ? `<p><a href="${h(t.call)}" style="background:#059669;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:700">Entrar na chamada</a></p>` : ""}
  ${t.notes ? `<p style="white-space:pre-wrap;color:#335;font-size:14px">${h(t.notes)}</p>` : ""}
  <p style="font-size:12px;color:#667">Responsável: ${h(NAMES[t.owner] || t.owner)}. ${kind === "cancelado" ? "O evento sai da sua agenda ao abrir o anexo." : "Abra o convite anexo (ou use os botões Sim/Não da sua agenda) para colocar na sua agenda."}</p>
  <p style="font-size:12px"><a href="${APP_URL}" style="color:#059669">Abrir o Kaizen</a></p></div></div>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to, subject, html,
      attachments: [{ filename: kind === "cancelado" ? "cancelamento.ics" : "convite.ics", content: b64(ics(t, id, seq, to, method)), content_type: `text/calendar; charset=utf-8; method=${method}` }],
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status} ${(await r.text()).slice(0, 300)}`);
}

const sig = (t: any, to: string[]) => JSON.stringify([t.title, t.start, t.time, Number(t.dur) || 60, t.rec || "", t.call || "", t.notes || "", [...to].sort()]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: true, service: "kaizen-convites", configured: !!RESEND });
  try {
    const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u, error: ue } = await db.auth.getUser(tok);
    if (ue || !u?.user) return json({ error: "login" }, 401);
    if (!RESEND) return json({ error: "config" }, 500);
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    if (!id) return json({ error: "id" }, 400);

    if (body.action === "cancel") {
      const t = body.task; const inv = t?.inv;
      if (!inv?.to?.length) return json({ ok: true, sent: 0 });
      await send(inv.to, t, id, (inv.seq || 0) + 1, "cancelado");
      return json({ ok: true, sent: inv.to.length });
    }

    if (body.action === "push") {
      const t = await getDoc("tasks", id);
      if (!t) return json({ ok: true, sent: 0 });
      const inv = t.inv || null;
      // deixou de ser reunião: cancela para todos
      if (!t.meeting) {
        if (inv?.to?.length) { await send(inv.to, { ...t, dur: inv.dur || 60 }, id, (inv.seq || 0) + 1, "cancelado"); }
        const next = { ...t }; delete next.inv; await putDoc("tasks", id, next);
        return json({ ok: true, sent: inv?.to?.length || 0 });
      }
      const map = await people();
      const att: string[] = Array.isArray(t.att) && t.att.length ? t.att : ["all"];
      const ids = att.includes("all") ? [...map.keys()] : [...new Set([...att, t.owner])];
      const to = [...new Set(ids.map((p) => map.get(p)).filter(Boolean) as string[])];
      const s = sig(t, to);
      if (inv && inv.sig === s) return json({ ok: true, sent: 0, unchanged: true });
      const seq = inv ? (inv.seq || 0) + 1 : 0;
      const removed = (inv?.to || []).filter((e: string) => !to.includes(e));
      if (removed.length) await send(removed, t, id, seq, "cancelado");
      await send(to, t, id, seq, inv ? "atualizado" : "novo");
      const cur = (await getDoc("tasks", id)) || t;
      await putDoc("tasks", id, { ...cur, inv: { seq, sig: s, to, dur: Number(t.dur) || 60 } });
      return json({ ok: true, sent: to.length });
    }
    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
