/**
 * Web Push from a Worker with nothing but WebCrypto (site audit II #37).
 *
 * Two standards do all the work:
 *   - VAPID (RFC 8292): every request to a push service carries a short
 *     ES256-signed JWT, so the service knows the sender is the same one the
 *     browser subscribed with (the page passes VAPID_PUBLIC to
 *     pushManager.subscribe).
 *   - Message encryption (RFC 8291, "aes128gcm" from RFC 8188): the payload
 *     is encrypted to the browser's own p256dh key and auth secret, so
 *     Apple/Google/Mozilla only ever carry ciphertext.
 *
 * Requires:
 *   - Var:     VAPID_PUBLIC       (base64url, 65-byte uncompressed P-256 point)
 *   - Secret:  VAPID_PRIVATE_JWK  (the matching private key as a JWK string)
 */
const SUBJECT = "https://bradbutcher321.github.io/RetirementLeague/";
const enc = new TextEncoder();

const b64uDecode = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const b64uEncode = (bytes) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function vapidHeader(env, endpoint) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64uEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: SUBJECT,
  })));
  // WebCrypto's ECDSA signature is already raw r||s, which is what JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64uEncode(sig)}, k=${env.VAPID_PUBLIC}`;
}

/** The aes128gcm body for one subscription: salt, record size, the
 * sender's one-off public key, then the encrypted payload. */
export async function encryptPayload(p256dh, authSecret, payload) {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  // RFC 8291 section 3.4: mix in the auth secret, then RFC 8188's key and nonce.
  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);

  // One record, so it ends with the last-record delimiter 0x02 and no padding.
  const plain = concat(enc.encode(payload), new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/** Sends one notification. Resolves to the push service's status: 201 is
 * delivered, 404/410 mean the subscription is gone for good. */
export async function sendPush(env, sub, message, ttl = 6 * 3600) {
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(env, sub.endpoint),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    },
    body,
  });
  return res.status;
}
