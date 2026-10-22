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
  // e-mails cadastrados pelos sócios (vale mesmo para quem ainda não fez o primeiro acesso)
  const { data: ppl } = await db.from("docs").select("id,data").eq("collection", "people");
  for (const r of ppl ?? []) { const e = String((r as any).data?.email || "").trim().toLowerCase(); if (e && !(r as any).data?.off) out.set((r as any).id, e); }
  let page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) break;
    for (const u of data.users) { const p = byUid.get(u.id); if (p && u.email && !out.has(p)) out.set(p, u.email.toLowerCase()); }
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

/* ---------- Google Agenda + Meet (quando a conta da empresa estiver conectada) ---------- */
const GCID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GCSECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
async function gToken(): Promise<string | null> {
  if (!GCID || !GCSECRET) return null;
  const { data } = await db.from("g_auth").select("refresh_token").eq("id", "org").maybeSingle();
  if (!data?.refresh_token) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GCID, client_secret: GCSECRET, refresh_token: data.refresh_token, grant_type: "refresh_token" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) { console.error("google token", r.status, JSON.stringify(j)); return null; }
  return j.access_token;
}
const isoLocal = (date: string, time: string, add = 0) => { const L = local(date, time, add); return `${L.slice(0, 4)}-${L.slice(4, 6)}-${L.slice(6, 8)}T${L.slice(9, 11)}:${L.slice(11, 13)}:00`; };
function gBody(t: any, to: string[], withMeet: boolean, id: string, seq: number) {
  const desc = [t.objetivo ? `Objetivo: ${t.objetivo}` : "", t.pauta ? `Pauta:\n${t.pauta}` : "", t.notes || "", `Marcada no Kaizen: ${APP_URL}`].filter(Boolean).join("\n\n");
  const b: any = {
    summary: t.title || "Reunião", description: desc,
    start: { dateTime: isoLocal(t.start, t.time), timeZone: "America/Sao_Paulo" },
    end: { dateTime: isoLocal(t.start, t.time, Number(t.dur) || 60), timeZone: "America/Sao_Paulo" },
    attendees: to.map((email) => ({ email })),
    reminders: { useDefault: true },
  };
  const rr = rrule(t); if (rr) b.recurrence = [rr];
  if (t.call) b.location = t.call;
  if (withMeet) b.conferenceData = { createRequest: { requestId: `kz-${id}-${seq}-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } } };
  return b;
}
async function gCall(tok: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events${path}`, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  if (!r.ok && !(method === "DELETE" && (r.status === 404 || r.status === 410))) throw new Error(`google ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
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
      if (inv?.gid) { const gt = await gToken(); if (gt) await gCall(gt, "DELETE", `/${inv.gid}?sendUpdates=all`); return json({ ok: true, sent: inv.to?.length || 0, google: true }); }
      if (!inv?.to?.length) return json({ ok: true, sent: 0 });
      await send(inv.to, t, id, (inv.seq || 0) + 1, "cancelado");
      return json({ ok: true, sent: inv.to.length });
    }

    if (body.action === "push") {
      const t = await getDoc("tasks", id);
      if (!t) return json({ ok: true, sent: 0 });
      const inv = t.inv || null;
      // deixou de ser reunião: cancela para todos
      if (!t.meeting && inv?.gid) {
        const gt = await gToken();
        if (gt) await gCall(gt, "DELETE", `/${inv.gid}?sendUpdates=all`);
        const next = { ...t }; delete next.inv; await putDoc("tasks", id, next);
        return json({ ok: true, sent: inv?.to?.length || 0, google: true });
      }
      if (!t.meeting) {
        if (inv?.to?.length) { await send(inv.to, { ...t, dur: inv.dur || 60 }, id, (inv.seq || 0) + 1, "cancelado"); }
        const next = { ...t }; delete next.inv; await putDoc("tasks", id, next);
        return json({ ok: true, sent: inv?.to?.length || 0 });
      }
      // reunião que já está no Google Agenda: atualiza ou cancela por lá
      const gtok = inv?.gid || !inv ? await gToken() : null;
      const map = await people();
      const att: string[] = Array.isArray(t.att) && t.att.length ? t.att : ["all"];
      const ids = att.includes("all") ? [...map.keys()] : [...new Set([...att, t.owner])];
      const to = [...new Set(ids.map((p) => map.get(p)).filter(Boolean) as string[])];
      const s = sig(t, to);
      if (inv && inv.sig === s) return json({ ok: true, sent: 0, unchanged: true });
      const seq = inv ? (inv.seq || 0) + 1 : 0;
      if (gtok && (!inv || inv.gid)) {
        const auto = !t.call || (inv?.meet && t.call === inv.meet);
        let ev: any;
        if (inv?.gid) ev = await gCall(gtok, "PATCH", `/${inv.gid}?sendUpdates=all&conferenceDataVersion=1`, gBody(t, to, false, id, seq));
        else ev = await gCall(gtok, "POST", `?sendUpdates=all&conferenceDataVersion=1`, gBody(t, to, auto, id, seq));
        const meet = ev?.hangoutLink || inv?.meet || "";
        const cur = (await getDoc("tasks", id)) || t;
        const call = auto && meet ? meet : cur.call || "";
        await putDoc("tasks", id, { ...cur, call, inv: { seq, sig: sig({ ...t, call }, to), to, dur: Number(t.dur) || 60, gid: ev?.id || inv?.gid, meet } });
        return json({ ok: true, sent: to.length, google: true, meet });
      }
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
