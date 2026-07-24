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
    // the edited bundle to the same token. Routed to a per-token Durable Object — strongly consistent and
    // NOT edge-cached, so the poller sees the editor's push on the very next poll (KV would make it wait out
    // a ~30–60s negative-lookup cache). One-shot: a successful GET consumes the pending bundle.
    //   POST /apply/<token>  -> { ok: true }
    //   GET  /apply/<token>  -> the pending bundle (and clears it), or 404 when nothing is pending
    const applySession = path.match(/^apply\/([A-Za-z0-9_-]{8,64})$/);
    if (applySession && (request.method === "POST" || request.method === "GET")) {
      const id = env.APPLY.idFromName(applySession[1]);
      return env.APPLY.get(id).fetch(request);
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

/**
 * One live-apply session, keyed by the token via idFromName. Strongly consistent and single-threaded, so
 * POST (editor pushes the bundle) and GET (plugin consumes it) never race and there is no edge cache to
 * wait out. The bundle is one-shot: GET returns it and deletes it. A self-scheduled alarm clears an
 * abandoned session so nothing lingers past the plugin's watch window.
 */
export class ApplySession {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
   try {
    if (request.method === "POST") {
      const body = await request.text();
      if (body.length > MAX_BYTES) return json({ error: "bundle too large" }, 413);
      try { JSON.parse(body); } catch { return json({ error: "body is not JSON" }, 400); }
      await this.state.storage.put("bundle", body);
      await this.state.storage.setAlarm(Date.now() + APPLY_TTL * 1000);   // self-clean if abandoned
      return json({ ok: true });
    }
    if (request.method === "GET") {
      const body = await this.state.storage.get("bundle");
      if (body == null) return json({ error: "nothing pending" }, 404);
      await this.state.storage.delete("bundle");
      return new Response(body, {
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
      });
    }
    return json({ error: "bad request" }, 400);
   } catch (e) {
    return json({ error: "apply session error" }, 500);
   }
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
