function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function isAuthorized(request, env) {
  if (!env.APP_PIN || !env.APPS_SCRIPT_API_BASE_URL) {
    return { ok: false, response: json({ ok: false, error: "The scanner service is not configured." }, 503) };
  }
  if (!safeEqual(request.headers.get("X-App-Pin"), env.APP_PIN)) {
    return { ok: false, response: json({ ok: false, error: "Incorrect scanner PIN." }, 401) };
  }
  return { ok: true };
}

function secureAssetHeaders(sourceHeaders) {
  const headers = new Headers(sourceHeaders);
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export { isAuthorized, json, safeEqual, secureAssetHeaders };
