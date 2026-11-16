/**
 * Web Push (RFC 8030, szyfrowanie RFC 8291, VAPID RFC 8292) w czystym WebCrypto: działa w Cloudflare Workers bez bibliotek.
 * Powiadomienia trafiają do zainstalowanej aplikacji (Chrome na Androidzie) przez usługę push przeglądarki, więc nie trzeba
 * konta Firebase ani płatnego serwisu.
 */
import { b64urlDecode, b64urlEncode, concat, enc } from "./crypto";

export interface PushSub {
  endpoint: string;
  p256dh: string; // klucz publiczny przeglądarki (base64url, 65 bajtów)
  auth: string; // sekret uwierzytelniający (base64url, 16 bajtów)
  createdAt: string;
}
export interface VapidKeys {
  publicKey: string; // base64url, 65 bajtów (applicationServerKey)
  privateJwk: JsonWebKey;
}

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;

export async function generateVapid(): Promise<VapidKeys> {
  const kp = (await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    publicKey: b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer)),
    privateJwk: (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey,
  };
}

/** JWT ES256 do nagłówka VAPID: podpis w formacie surowym r||s (tak zwraca WebCrypto), jak wymaga RFC 8292. */
export async function vapidJwt(keys: VapidKeys, audience: string, subject: string, nowMs = Date.now(), ttlS = 12 * 3600): Promise<string> {
  const part = (o: unknown) => b64urlEncode(enc.encode(JSON.stringify(o)));
  const input = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(nowMs / 1000) + ttlS, sub: subject })}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateJwk, ECDSA, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input)));
  return `${input}.${b64urlEncode(sig)}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

/**
 * Szyfruje ładunek dla subskrypcji (aes128gcm, RFC 8291). Zwraca gotowe ciało żądania:
 * salt(16) | rs(4) | idlen(1) | klucz publiczny serwera(65) | szyfrogram. salt i para kluczy są parametrami tylko po to,
 * żeby test mógł użyć wektora z RFC; normalnie są losowe.
 */
export async function encryptPayload(plain: Uint8Array, p256dh: string, authSecret: string, opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  const serverKeys = opts.serverKeys ?? ((await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair);
  const serverPublic = new Uint8Array((await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, serverKeys.privateKey, 256)); // workers-types nazywa pole $public, w czasie wykonania (i w WebCrypto) to "public"
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, serverPublic), 32);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 = ogranicznik ostatniego rekordu; jeden rekord wystarcza (ładunek znacznie poniżej rs = 4096)
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plain, new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([serverPublic.length]), serverPublic, cipher);
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** Subskrypcja wygasła lub została cofnięta (404/410): należy ją usunąć. */
  gone: boolean;
}

export const MAX_PAYLOAD_CHARS = 2400;

/** Wysyła jedno powiadomienie. Nie rzuca wyjątków: wynik opisuje, co się stało. */
export async function sendPush(sub: PushSub, payload: unknown, keys: VapidKeys, opts: { subject: string; ttlS?: number; urgency?: "very-low" | "low" | "normal" | "high" }): Promise<PushResult> {
  try {
    const json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD_CHARS) throw new Error(`ładunek za duży (${json.length})`);
    const body = await encryptPayload(enc.encode(json), sub.p256dh, sub.auth);
    const jwt = await vapidJwt(keys, new URL(sub.endpoint).origin, opts.subject);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(opts.ttlS ?? 86400),
        Urgency: opts.urgency ?? "normal",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.status === 201 || res.status === 200 || res.status === 202, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    console.error("push send failed", e instanceof Error ? e.message : e);
    return { ok: false, status: 0, gone: false };
  }
}
