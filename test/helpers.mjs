// A closebook server on a free port with a clean environment (no real keys), and a tiny client
// that keeps its own cookie, so a test can be two browsers at once.
export async function startServer(env = {}) {
  for (const k of ['ANTHROPIC_API_KEY', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']) delete process.env[k];
  Object.assign(process.env, env);
  const { start } = await import('../server.mjs');
  const server = await start(0, { quiet: true });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export function browser(base) {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async call(path, body, method) {
      const res = await fetch(base + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data, headers: res.headers };
    },
  };
}
