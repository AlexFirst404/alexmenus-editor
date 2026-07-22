// AlexMenus paste service — a tiny bytebin-like store for the LuckPerms-style menu editor.
//
//   POST /post   (JSON body, the menu bundle)  -> { "key": "<code>" }   (stored in KV, TTL 24h)
//   GET  /<key>                                -> the stored JSON        (or 404)
//
// CORS is open so the hosted editor (GitHub Pages) can read/write. The plugin only makes
// outbound calls to this Worker — no ports are opened on the game server.
//
// Deploy: see README.md in this folder. Needs one KV namespace bound as PASTES.

const TTL = 86400;                 // paste lifetime: 24h
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB bundle cap
const KEY_LEN = 8;
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no look-alikes (0/o/1/l)

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
  });
}

function randomKey() {
  const bytes = new Uint8Array(KEY_LEN);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");

    // Upload a bundle.
    if (request.method === "POST" && path === "post") {
      const body = await request.text();
      if (body.length > MAX_BYTES) return json({ error: "bundle too large" }, 413);
      try { JSON.parse(body); } catch { return json({ error: "body is not JSON" }, 400); }
      const key = randomKey();
      await env.PASTES.put(key, body, { expirationTtl: TTL });
      return json({ key });
    }

    // Fetch a bundle by code.
    if (request.method === "GET" && /^[a-z2-9]{4,16}$/.test(path)) {
      const val = await env.PASTES.get(path);
      if (val === null) return json({ error: "not found or expired" }, 404);
      return new Response(val, {
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
      });
    }

    if (request.method === "GET" && path === "") {
      return json({ ok: true, service: "alexmenus-paste" });
    }
    return json({ error: "bad request" }, 400);
  },
};
