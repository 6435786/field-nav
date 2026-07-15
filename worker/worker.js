// field-nav backend: URL resolver + elevation proxy + geocoder
// Endpoints:
//   /?url=ENCODED_URL                     → follows redirects, returns {finalUrl, status, body}
//   /elevation?locations=lat,lon|lat,lon  → proxies OpenTopoData SRTM 30m (CORS-friendly)
//   /geocode?address=...                  → resolves an address to {lat,lng} via Google
//                                           Geocoding API. Key in env.GOOGLE_GEOCODE_KEY
//                                           (a Worker secret). Results edge-cached 30 days
//                                           so repeat lookups cost 0 Google calls.
//
// NOTE: keep this file in sync with the Worker deployed at
// delicate-math-4110.6435786.workers.dev (edited via the Cloudflare dashboard).

const ALLOWED_ORIGINS = [
  'https://6435786.github.io',
  'https://drone-field-nav.pages.dev',
  'http://localhost:8080',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const baseCors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseCors });
    }

    const url = new URL(request.url);

    // ===== /elevation — proxy OpenTopoData with CORS =====
    if (url.pathname === '/elevation') {
      const locations = url.searchParams.get('locations');
      if (!locations) {
        return jsonResponse({ error: 'Missing locations parameter' }, 400, baseCors);
      }
      try {
        const otdUrl = `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locations)}`;
        const res = await fetch(otdUrl);
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', ...baseCors }
        });
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 502, baseCors);
      }
    }

    // ===== /geocode — resolve an address to coordinates via Google Geocoding API =====
    if (url.pathname === '/geocode') {
      const address = url.searchParams.get('address');
      if (!address) {
        return jsonResponse({ error: 'Missing address parameter' }, 400, baseCors);
      }
      if (!env || !env.GOOGLE_GEOCODE_KEY) {
        return jsonResponse({ error: 'Geocoding not configured' }, 500, baseCors);
      }
      // address → coords is stable, so edge-cache aggressively to avoid repeat Google
      // calls (protects both cost and the 100/day quota). Cache holds a plain,
      // origin-agnostic payload; CORS for the current origin is re-attached on hit.
      const cache = caches.default;
      const cacheKey = new Request('https://geocode.cache/v1?a=' + encodeURIComponent(address));
      const hit = await cache.match(cacheKey);
      if (hit) {
        const data = await hit.json();
        return jsonResponse(data, 200, baseCors);
      }
      try {
        const gUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=il&language=he&key=${env.GOOGLE_GEOCODE_KEY}`;
        const res = await fetch(gUrl);
        const g = await res.json();
        if (g.status === 'OK' && g.results && g.results[0]) {
          const loc = g.results[0].geometry.location;
          const out = { lat: loc.lat, lng: loc.lng, formatted: g.results[0].formatted_address };
          if (ctx && ctx.waitUntil) {
            ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(out), {
              headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=2592000' },
            })));
          }
          return jsonResponse(out, 200, baseCors);
        }
        return jsonResponse({ error: 'No result', status: g.status || 'UNKNOWN' }, 200, baseCors);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 502, baseCors);
      }
    }

    // ===== /?url=... — URL resolver =====
    const target = url.searchParams.get('url');
    if (!target) {
      return jsonResponse({ error: 'Missing url parameter' }, 400, baseCors);
    }

    let parsed;
    try { parsed = new URL(target); } catch (e) {
      return jsonResponse({ error: 'Invalid URL' }, 400, baseCors);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ error: 'Only http(s) URLs allowed' }, 400, baseCors);
    }

    try {
      const res = await fetch(target, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const body = await res.text();
      const trimmed = body.length > 1000000 ? body.slice(0, 1000000) : body;
      return new Response(JSON.stringify({
        finalUrl: res.url,
        status: res.status,
        body: trimmed,
      }), {
        headers: { 'Content-Type': 'application/json', ...baseCors }
      });
    } catch (e) {
      return jsonResponse({ error: String(e.message || e) }, 502, baseCors);
    }
  }
};
