/** Telegram Bot API, called directly (no Composio). */

const API = "https://api.telegram.org";

export async function tg(env: Env, method: string, body: unknown): Promise<any> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Brak TELEGRAM_BOT_TOKEN");
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(`Telegram ${method} ${res.status}: ${json.description ?? ""}`);
  return json.result;
}

export async function sendTelegram(env: Env, text: string) {
  if (!env.TELEGRAM_CHAT_ID) throw new Error("Brak TELEGRAM_CHAT_ID");
  // Telegram limit is 4096 chars per message.
  const parts: string[] = [];
  for (let rest = text.trim(); rest.length; ) {
    if (rest.length <= 4000) {
      parts.push(rest);
      break;
    }
    const cut = rest.lastIndexOf("\n", 4000) > 2000 ? rest.lastIndexOf("\n", 4000) : 4000;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  for (const p of parts) await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: p });
}

/** Secret Telegram must send back with every webhook call. Derived, so there is one less secret to set. */
export async function webhookSecret(env: Env): Promise<string> {
  const data = new TextEncoder().encode(`telegram-webhook:${env.MCP_PASSWORD}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!timingSafeEqual(got, await webhookSecret(env))) return new Response("forbidden", { status: 403 });

  const update: any = await request.json().catch(() => null);
  const msg = update?.message ?? update?.edited_message;
  if (!msg) return new Response("ok");
  if (String(msg.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) return new Response("ok"); // ignore strangers

  let text: string = msg.text ?? msg.caption ?? "";
  if (!text) {
    if (msg.voice) text = "[Jan wysłał wiadomość głosową; trener jej nie odsłuchuje, poproś o tekst]";
    else if (msg.photo) text = "[Jan wysłał zdjęcie bez opisu]";
    else if (msg.sticker) text = `[naklejka ${msg.sticker.emoji ?? ""}]`;
    else return new Response("ok");
  }
  if (text.trim() === "/start") return new Response("ok");

  const at = new Date((msg.date ?? Date.now() / 1000) * 1000).toISOString();
  await coach(env).addIncoming(text, at);
  return new Response("ok");
}

export function coach(env: Env) {
  return env.COACH_STATE.get(env.COACH_STATE.idFromName("jan"));
}
