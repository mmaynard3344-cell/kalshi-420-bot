/**
 * Session-expiry guard for the private Replit deployment.
 *
 * The published app has private visibility: every request must carry a valid
 * Replit auth cookie. When that cookie expires, API fetches are answered with
 * a 307 redirect to Replit's login shield (replit.com/__replshield). From the
 * page's perspective this looks like a random network/HTML error — the classic
 * "endpoint — HTTP …" banner.
 *
 * checkSessionAndRecover() probes a cheap API endpoint with redirect:'manual'.
 * Our API never issues redirects, so ANY redirect answer means the auth cookie
 * has expired. In that case we reload the page: a top-level navigation goes
 * back through the shield, which silently renews the cookie for a logged-in
 * Replit user (or shows the login page if they're fully signed out — either
 * way, far clearer than a cryptic fetch error).
 *
 * Reloads are throttled via sessionStorage so a genuinely signed-out user
 * can't get stuck in a reload loop.
 */

const RELOAD_THROTTLE_MS = 60_000;
const THROTTLE_KEY = 'sessionGuardReloadAt';

let probeInFlight: Promise<boolean> | null = null;
// In-memory fallback so a page lifecycle only ever triggers one reload even
// when sessionStorage is unavailable (e.g. blocked by browser settings).
let reloadedThisLifecycle = false;

async function probe(): Promise<boolean> {
  try {
    const url = new URL('/api/prices', window.location.origin).toString();
    const res = await fetch(url, {
      redirect: 'manual',
      credentials: 'include',
      cache: 'no-store',
    });
    // Same-origin fetch with redirect:'manual' yields an opaqueredirect
    // (status 0) when the server answers with a redirect.
    const expired =
      res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
    if (!expired) return false;

    let last = 0;
    try {
      last = Number(sessionStorage.getItem(THROTTLE_KEY) ?? 0);
    } catch {
      /* sessionStorage unavailable — still reload, just unthrottled */
    }
    if (!reloadedThisLifecycle && Date.now() - last > RELOAD_THROTTLE_MS) {
      reloadedThisLifecycle = true;
      try {
        sessionStorage.setItem(THROTTLE_KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
      console.warn('[sessionGuard] Replit session expired — reloading to renew auth cookie');
      window.location.reload();
    }
    return true;
  } catch {
    // Network truly down, server unreachable, etc. — not a session issue.
    return false;
  }
}

/**
 * Returns true when the Replit session has expired (and a page reload has
 * been scheduled). Call this from fetch error handlers before surfacing an
 * error banner. Concurrent calls share one probe.
 */
export function checkSessionAndRecover(): Promise<boolean> {
  if (!probeInFlight) {
    probeInFlight = probe().finally(() => {
      probeInFlight = null;
    });
  }
  return probeInFlight;
}
