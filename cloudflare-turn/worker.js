// Genera credenziali temporanee per il ripetitore TURN di Cloudflare.
// I segreti (TURN_KEY_ID, TURN_KEY_API_TOKEN) restano su Cloudflare, mai nel sito.
const ALLOWED = [/^https:\/\/pipp010\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

function corsFor(origin) {
  const ok = ALLOWED.some((re) => re.test(origin));
  return {
    ok,
    headers: {
      'Access-Control-Allow-Origin': ok ? origin : 'https://pipp010.github.io',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    },
  };
}

// L'ID della chiave ha 32 caratteri, il token 64: se sono stati inseriti al contrario li scambio
function keys(env) {
  let id = String(env.TURN_KEY_ID || '').trim();
  let token = String(env.TURN_KEY_API_TOKEN || '').trim();
  if (id.length > token.length) [id, token] = [token, id];
  return { id, token };
}

export default {
  async fetch(request, env) {
    const { ok, headers } = corsFor(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (!ok) return new Response('Accesso non consentito', { status: 403, headers });

    const { id, token } = keys(env);
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    const json = { 'Content-Type': 'application/json', ...headers };
    if (!res.ok) return new Response(JSON.stringify({ error: 'cloudflare ' + res.status }), { status: 502, headers: json });

    const data = await res.json();
    // I browser bloccano la porta 53: la tolgo per evitare attese inutili
    const list = [].concat(data.iceServers || [])
      .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    return new Response(JSON.stringify({ iceServers: list }), { headers: json });
  },
};
