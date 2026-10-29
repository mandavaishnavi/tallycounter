// Worker entry point. Serves the app's static files and handles /api/state.
// Use this layout when your Cloudflare project is a Worker (not Pages).
//
// Bindings expected on the project:
//   DB        D1 database binding
//   SYNC_KEY  secret text, the key you type into the app on each device
//   ASSETS    static assets binding (declared in wrangler.jsonc)

const MAX_BYTES = 512 * 1024;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Length-independent comparison, so a wrong key leaks nothing through timing.
function keyMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleState(request, env) {
  if (!env.SYNC_KEY || !env.DB) {
    return json({ error: "sync is not configured on this deployment" }, 503);
  }
  if (!keyMatches(request.headers.get("x-sync-key") || "", env.SYNC_KEY)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT data, updated_at FROM state WHERE id = ?"
    ).bind("me").first();
    if (!row) return json({ updatedAt: 0, data: null });
    let data = null;
    try { data = JSON.parse(row.data); } catch (e) { data = null; }
    return json({ updatedAt: Number(row.updated_at) || 0, data });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    if (!body || typeof body.data !== "object" || body.data === null) {
      return json({ error: "expected { updatedAt, data }" }, 400);
    }
    const payload = JSON.stringify(body.data);
    if (payload.length > MAX_BYTES) return json({ error: "payload too large" }, 413);

    const updatedAt = Number(body.updatedAt) || Date.now();
    await env.DB.prepare(
      "INSERT INTO state (id, data, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"
    ).bind("me", payload, updatedAt).run();

    return json({ ok: true, updatedAt });
  }

  return json({ error: "method not allowed" }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/state") return handleState(request, env);
    return env.ASSETS.fetch(request);
  },
};
