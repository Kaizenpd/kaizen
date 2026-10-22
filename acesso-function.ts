// Kaizen: primeiro acesso sem depender de e-mail de confirmação.
// Só cria login para e-mails que os sócios cadastraram no Kaizen (coleção people) e que ainda não têm senha.
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
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function findUser(email: string): Promise<any> {
  let page = 1;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
    page++;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: true, service: "kaizen-acesso" });
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "email" }, 400);
    if (password.length < 8) return json({ error: "senha" }, 400);
    const { data: ppl } = await db.from("docs").select("id,data").eq("collection", "people");
    const p = (ppl ?? []).find((r: any) => String(r.data?.email || "").trim().toLowerCase() === email && !r.data?.off);
    if (!p) return json({ error: "naocadastrado" }, 403);
    const old = await findUser(email);
    if (old) {
      // cadastro antigo que nunca foi confirmado nem usado: libera com a senha nova
      if (!old.email_confirmed_at && !old.last_sign_in_at) {
        const { error: e2 } = await db.auth.admin.updateUserById(old.id, { password, email_confirm: true });
        return e2 ? json({ error: "falha" }, 400) : json({ ok: true });
      }
      return json({ error: "existe" }, 409);
    }
    const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { person: (p as any).id } });
    if (error) return json({ error: /registered|exists/i.test(error.message) ? "existe" : "falha" }, 400);
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "falha" }, 500);
  }
});
