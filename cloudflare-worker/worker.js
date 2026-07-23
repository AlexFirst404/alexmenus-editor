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
const APPLY_TTL = 600;             // live-apply push lifetime — matches the plugin's 10m watch window,
                                   // so a push can't outlive the watcher that would consume it
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

    // Live "Apply": the plugin mints a session token in-game (/am editor) and polls it; the editor pushes
    // the edited bundle to the same token. One-shot — a successful GET consumes the pending bundle.
    //   POST /apply/<token>  -> { ok: true }
    //   GET  /apply/<token>  -> the pending bundle (and clears it), or 404 when nothing is pending
    const applySession = path.match(/^apply\/([A-Za-z0-9_-]{8,64})$/);
    if (applySession) {
      const kvKey = "apply:" + applySession[1];
      if (request.method === "POST") {
        const body = await request.text();
        if (body.length > MAX_BYTES) return json({ error: "bundle too large" }, 413);
        try { JSON.parse(body); } catch { return json({ error: "body is not JSON" }, 400); }
        await env.PASTES.put(kvKey, body, { expirationTtl: APPLY_TTL });
        return json({ ok: true });
      }
      if (request.method === "GET") {
        // Short cacheTtl: KV caches NEGATIVE lookups at the edge too (60s by default), which would make the
        // plugin's poller keep seeing "nothing pending" long after the editor pushed. This shortens that
        // window; it does not eliminate it (a Durable Object would — see README).
        const val = await env.PASTES.get(kvKey, { cacheTtl: 30 });
        if (val === null) return json({ error: "nothing pending" }, 404);
        await env.PASTES.delete(kvKey);
        return new Response(val, {
          headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
        });
      }
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
