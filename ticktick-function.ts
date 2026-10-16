// Kaizen <-> TickTick (sincronização nos dois sentidos)
// Ações: start | callback (GET) | projects | setProject | push | poll | disconnect
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
const CID = Deno.env.get("TICKTICK_CLIENT_ID") ?? "";
const CSECRET = Deno.env.get("TICKTICK_CLIENT_SECRET") ?? "";
const APP_URL = Deno.env.get("KAIZEN_URL") ?? "https://kaizen.exposia.com.br/";
const REDIRECT = `${SUPA_URL}/functions/v1/ticktick`;
const API = "https://api.ticktick.com/open/v1";
const TZ = "America/Sao_Paulo";

const db = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- utilidades ---------- */
async function hmac(s: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(CSECRET + SERVICE.slice(-16)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/[+/=]/g, "");
}
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/=+$/, "");
const unb64 = (s: string) => decodeURIComponent(escape(atob(s)));

async function getDoc(col: string, id: string) {
  const { data } = await db.from("docs").select("data").eq("collection", col).eq("id", id).maybeSingle();
  return data?.data ?? null;
}
async function putDoc(col: string, id: string, data: unknown) {
  const { error } = await db.from("docs").upsert({ collection: col, id, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function delDoc(col: string, id: string) {
  await db.from("docs").delete().eq("collection", col).eq("id", id);
}

async function caller(req: Request) {
  const tok = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const { data, error } = await db.auth.getUser(tok);
  if (error || !data?.user) return null;
  const m = await getDoc("members", data.user.id);
  return { uid: data.user.id, person: (m?.person as string) || "" };
}

type Link = { person: string; user_id: string; access_token: string; project_id: string | null; project_name: string | null };
async function getLink(person: string): Promise<Link | null> {
  const { data } = await db.from("tt_links").select("*").eq("person", person).maybeSingle();
  return data as Link | null;
}

async function tt(link: Link, method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${link.access_token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 401) {
    await setStatus(link.person, { connected: false, error: "A conexão com o TickTick expirou. Conecte de novo." });
    throw new Error("unauthorized");
  }
  const txt = await r.text();
  if (!r.ok) { const e = new Error(`tt ${r.status} ${txt.slice(0, 200)}`); (e as any).status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

async function setStatus(person: string, patch: Record<string, unknown>) {
  const cur = (await getDoc("ticktick", person)) ?? {};
  await putDoc("ticktick", person, { ...cur, ...patch });
}

/* ---------- conversão de datas (horário de Brasília) ---------- */
// Kaizen: data "YYYY-MM-DD" + hora "HH:MM" (opcional), sempre em Brasília (UTC-3)
function toTT(date: string, time: string) {
  if (!date) return {};
  const [h, m] = time ? time.split(":").map(Number) : [0, 0];
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h + 3, m));
  const iso = d.toISOString().slice(0, 19) + "+0000";
  return { dueDate: iso, startDate: iso, isAllDay: !time, timeZone: TZ };
}
function fromTT(t: any): { date: string; time: string } {
  const raw = t.dueDate || t.startDate;
  if (!raw) return { date: "", time: "" };
  const ms = Date.parse(String(raw).replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  const local = new Date(ms - 3 * 3600 * 1000).toISOString();
  return { date: local.slice(0, 10), time: t.isAllDay ? "" : local.slice(11, 16) };
}
const kDate = (k: any) => k.end || k.start || "";
const normK = (k: any) => JSON.stringify([String(k.title ?? "").trim(), String(k.notes ?? "").trim(), kDate(k), k.time || ""]);
const normT = (t: any) => { const f = fromTT(t); return JSON.stringify([String(t.title ?? "").trim(), String(t.content ?? "").trim(), f.date, f.time]); };

/* ---------- Kaizen -> TickTick para uma tarefa ---------- */
async function pushTask(id: string, k: any): Promise<void> {
  if (!k) return;
  let meta = k.tt ? { ...k.tt } : null;
  let changed = false;

  // trocou de dono: tira da lista do dono antigo
  if (meta && meta.who !== k.owner) {
    const old = await getLink(meta.who);
    if (old) { try { await tt(old, "DELETE", `/project/${meta.pid}/task/${meta.id}`); } catch (_) { /* já não existe */ } }
    meta = null; changed = true;
  }
  const link = await getLink(k.owner);
  if (!link || !link.project_id) { if (changed) await saveMeta(id, null); return; }

  const body = {
    title: String(k.title || "Sem título"),
    content: String(k.notes || ""),
    projectId: link.project_id,
    ...toTT(kDate(k), k.time || ""),
  };

  if (!meta) {
    if (k.status === "done") { if (changed) await saveMeta(id, null); return; }
    const created = await tt(link, "POST", "/task", body);
    await saveMeta(id, { id: created.id, pid: link.project_id, who: k.owner, s: normK(k), ts: normT(created ?? body), done: false });
    return;
  }

  const nk = normK(k);
  if (nk !== meta.s) {
    const upd = await tt(link, "POST", `/task/${meta.id}`, { id: meta.id, ...body, projectId: meta.pid });
    meta.s = nk; meta.ts = normT(upd ?? body); changed = true;
  }
  if (k.status === "done" && !meta.done) {
    await tt(link, "POST", `/project/${meta.pid}/task/${meta.id}/complete`);
    meta.done = true; changed = true;
  } else if (k.status !== "done" && meta.done) {
    await tt(link, "POST", `/task/${meta.id}`, { id: meta.id, projectId: meta.pid, status: 0 });
    meta.done = false; changed = true;
  }
  if (changed) await saveMeta(id, meta);
}

async function saveMeta(id: string, meta: any) {
  const cur = await getDoc("tasks", id);
  if (!cur) return;
  const next = { ...cur };
  if (meta) next.tt = meta; else delete next.tt;
  await putDoc("tasks", id, next);
}

/* ---------- TickTick -> Kaizen (e reconciliação) para um vínculo ---------- */
async function syncLink(link: Link) {
  if (!link.project_id) return { skipped: true };
  const data = await tt(link, "GET", `/project/${link.project_id}/data`);
  const open: any[] = data?.tasks ?? [];
  const openById = new Map(open.map((t) => [t.id, t]));

  const { data: rows } = await db.from("docs").select("id,data,updated_at").eq("collection", "tasks");
  const all = (rows ?? []) as { id: string; data: any; updated_at: string }[];
  const fresh = (r: { updated_at: string }) => Date.now() - Date.parse(r.updated_at) < 60_000;
  const byTT = new Map<string, { id: string; data: any }>();
  for (const r of all) if (r.data?.tt?.id && r.data.tt.who === link.person) byTT.set(r.data.tt.id, r);

  let pulled = 0, pushed = 0;
  const handled = new Set<string>();

  // 1) tarefas abertas no TickTick
  for (const t of open) {
    const hit = byTT.get(t.id);
    if (hit) handled.add(hit.id);
    const f = fromTT(t);
    if (!hit) {
      const id = `tt_${t.id}`;
      if (all.some((r) => r.id === id)) continue;
      const k = {
        title: t.title || "Sem título", owner: link.person, phase: "gestao",
        start: f.date || new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), end: "", time: f.time,
        status: "todo", milestone: false, notes: t.content || "", link: "",
      };
      await putDoc("tasks", id, { ...k, tt: { id: t.id, pid: link.project_id, who: link.person, s: normK(k), ts: normT(t), done: false } });
      pulled++;
      continue;
    }
    const k = { ...hit.data };
    const meta = { ...k.tt };
    const nt = normT(t);
    let dirty = false;
    if (nt !== meta.ts) { // mudou no TickTick
      k.title = t.title || k.title;
      k.notes = t.content ?? "";
      if (f.date) { if (k.end) k.end = f.date; else k.start = f.date; }
      k.time = f.time;
      meta.s = normK(k); meta.ts = nt; dirty = true; pulled++;
    } else if (normK(k) !== meta.s) { // mudou só no Kaizen (envio falhou antes)
      await pushTask(hit.id, k); pushed++; continue;
    }
    if (k.status === "done") {
      if (meta.done) { k.status = "todo"; meta.done = false; dirty = true; pulled++; } // reaberta no TickTick
      else { await tt(link, "POST", `/project/${meta.pid}/task/${meta.id}/complete`); meta.done = true; dirty = true; pushed++; }
    }
    if (dirty) { k.tt = meta; await putDoc("tasks", hit.id, k); }
  }

  // 2) vinculadas que não estão mais abertas no TickTick
  for (const [ttid, r] of byTT) {
    if (openById.has(ttid)) continue;
    const k = { ...r.data }; const meta = { ...k.tt };
    handled.add(r.id);
    if (k.owner !== link.person) { await pushTask(r.id, k); continue; }
    if (meta.done && k.status === "done") continue;
    let t: any = null;
    try { t = await tt(link, "GET", `/project/${meta.pid}/task/${ttid}`); } catch (_) { t = null; }
    if (t && t.status === 2) {
      if (k.status !== "done" || !meta.done) { k.status = "done"; meta.done = true; k.tt = meta; await putDoc("tasks", r.id, k); pulled++; }
    } else if (!t || t.projectId !== link.project_id || t.deleted) {
      // apagada ou movida para outra lista no TickTick
      if (r.id.startsWith("tt_")) await delDoc("tasks", r.id);
      else { delete k.tt; await putDoc("tasks", r.id, k); }
      pulled++;
    }
  }

  // 3) tarefas do Kaizen dessa pessoa ainda sem cópia no TickTick
  for (const r of all) {
    const k = r.data; if (!k || handled.has(r.id) || fresh(r)) continue;
    if (k.owner === link.person && !k.tt && k.status !== "done") { await pushTask(r.id, k); pushed++; }
    else if (k.tt && k.tt.who === link.person && k.owner !== link.person) { await pushTask(r.id, k); pushed++; }
  }

  await setStatus(link.person, { connected: true, list: link.project_name, lastSync: new Date().toISOString(), error: null });
  return { pulled, pushed };
}

/* ---------- servidor ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  try {
    // retorno do TickTick depois do "Autorizar"
    if (req.method === "GET" && url.searchParams.has("code")) {
      const code = url.searchParams.get("code")!;
      const [p, sig] = (url.searchParams.get("state") ?? "").split(".");
      if (!p || sig !== (await hmac(p))) return Response.redirect(APP_URL + "?tt=erro", 302);
      const st = JSON.parse(unb64(p));
      if (Date.now() > st.exp) return Response.redirect(APP_URL + "?tt=erro", 302);
      const r = await fetch("https://ticktick.com/oauth/token", {
        method: "POST",
        headers: { Authorization: "Basic " + btoa(`${CID}:${CSECRET}`), "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, grant_type: "authorization_code", scope: "tasks:read tasks:write", redirect_uri: REDIRECT }),
      });
      const tok = await r.json().catch(() => ({}));
      if (!r.ok || !tok.access_token) return Response.redirect(APP_URL + "?tt=erro", 302);
      const prev = await getLink(st.person);
      await db.from("tt_links").upsert({
        person: st.person, user_id: st.uid, access_token: tok.access_token,
        project_id: prev?.project_id ?? null, project_name: prev?.project_name ?? null, updated_at: new Date().toISOString(),
      });
      await setStatus(st.person, { connected: true, list: prev?.project_name ?? null, error: null });
      return Response.redirect(APP_URL + (prev?.project_id ? "?tt=ok" : "?tt=lista"), 302);
    }
    if (req.method === "GET") return json({ ok: true, service: "kaizen-ticktick" });

    const body = await req.json().catch(() => ({}));
    const action = body.action as string;

    // sincronização periódica (agendada a cada 5 min)
    if (action === "poll") {
      const { data: links } = await db.from("tt_links").select("*").not("project_id", "is", null);
      const out: Record<string, unknown> = {};
      for (const l of (links ?? []) as Link[]) {
        try { out[l.person] = await syncLink(l); }
        catch (e) { out[l.person] = { error: String(e) }; if (String(e) !== "Error: unauthorized") await setStatus(l.person, { error: "Falha na última sincronização. Tentando de novo em 5 min." }); }
      }
      return json({ ok: true, out });
    }

    const who = await caller(req);
    if (!who || !who.person) return json({ error: "login" }, 401);

    if (action === "start") {
      if (!CID || !CSECRET) return json({ error: "config" }, 500);
      const p = b64(JSON.stringify({ uid: who.uid, person: who.person, exp: Date.now() + 15 * 60 * 1000 }));
      const state = `${p}.${await hmac(p)}`;
      const q = new URLSearchParams({ client_id: CID, scope: "tasks:read tasks:write", state, redirect_uri: REDIRECT, response_type: "code" });
      return json({ url: `https://ticktick.com/oauth/authorize?${q}` });
    }

    const link = await getLink(who.person);

    if (action === "projects") {
      if (!link) return json({ error: "notlinked" }, 400);
      const ps = await tt(link, "GET", "/project");
      return json({ projects: (ps ?? []).filter((p: any) => !p.closed).map((p: any) => ({ id: p.id, name: p.name })) });
    }
    if (action === "setProject") {
      if (!link) return json({ error: "notlinked" }, 400);
      await db.from("tt_links").update({ project_id: body.id, project_name: body.name, updated_at: new Date().toISOString() }).eq("person", who.person);
      const fresh = (await getLink(who.person))!;
      await setStatus(who.person, { connected: true, list: body.name, error: null });
      const res = await syncLink(fresh);
      return json({ ok: true, ...res });
    }
    if (action === "syncNow") {
      if (!link) return json({ error: "notlinked" }, 400);
      return json({ ok: true, ...(await syncLink(link)) });
    }
    if (action === "disconnect") {
      await db.from("tt_links").delete().eq("person", who.person);
      await delDoc("ticktick", who.person);
      return json({ ok: true });
    }

    // alteração feita no Kaizen
    if (action === "push") {
      if (body.deleted && body.tt?.id) {
        const l = await getLink(body.tt.who);
        if (l) { try { await tt(l, "DELETE", `/project/${body.tt.pid}/task/${body.tt.id}`); } catch (_) { /* ok */ } }
        return json({ ok: true });
      }
      const k = await getDoc("tasks", String(body.id));
      await pushTask(String(body.id), k);
      return json({ ok: true });
    }

    return json({ error: "action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
