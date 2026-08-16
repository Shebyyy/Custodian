import { getConfig } from "./config.js";
import { getDb } from "./db.js";

// ─── Rate Limit Configuration ───

export const DEFAULT_RATE_LIMITS = {
  /** Delay (ms) between migration member-add calls */
  migrationDelayMs: 1500,
  /** Delay (ms) between restore message posts */
  restoreDelayMs: 1000,
  /** Max retries on 429 before giving up */
  maxRetries: 3,
  /** Batch size for migration (pause after this many adds) */
  batchSize: 10,
  /** Extra pause (ms) between batches */
  batchPauseMs: 3000,
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ─── Rate-Limited Fetch Wrapper ───

export type FetchResult = {
  ok: boolean;
  status: number;
  body: string | null;
  fatal: boolean;  // true = 401/403/404 — do NOT retry
  rateLimited: boolean;  // true = 429 — may retry later
  retryAfter?: number;  // seconds to wait (from 429)
};

/**
 * Rate-limit-aware fetch wrapper.
 * - On success (2xx): returns { ok: true }
 * - On 429: reads Retry-After header, retries up to `maxRetries` times
 * - On 401/403/404: returns { fatal: true } — caller MUST stop retrying
 * - On other errors: returns { ok: false }
 *
 * Respects Discord's rules:
 *   • Never retry 401/403/404 (they count toward the 10k/10min IP ban)
 *   • Always respect Retry-After on 429
 *   • Log every rate limit event for debugging
 */
export async function rateLimitedFetch(
  url: string,
  options: RequestInit,
  maxRetries: number = DEFAULT_RATE_LIMITS.maxRetries,
): Promise<FetchResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    // ── Success ──
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, body: null, fatal: false, rateLimited: false };
    }

    // ── Already a member (204 No Content) ──
    if (res.status === 204) {
      return { ok: true, status: 204, body: null, fatal: false, rateLimited: false };
    }

    // ── Fatal errors — DO NOT RETRY ──
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      const errBody = await res.text().catch(() => "");
      console.error(`[RateLimit] Fatal ${res.status} on ${options.method || 'GET'} ${url}: ${errBody.slice(0, 200)}`);
      return {
        ok: false, status: res.status, body: errBody,
        fatal: true, rateLimited: false,
 };
    }

    // ── Rate limited (429) ──
    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "5");
      const isGlobal = res.headers.get("X-RateLimit-Global") === "true";
      const scope = res.headers.get("X-RateLimit-Scope") || "unknown";

      console.warn(`[RateLimit] 429 ${isGlobal ? "GLOBAL" : scope} on ${options.method || 'GET'} ${url} — Retry-After: ${retryAfter}s (attempt ${attempt + 1}/${maxRetries + 1})`);

      if (attempt < maxRetries) {
        // Wait the Retry-After time (+ 500ms buffer)
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }

      // Exhausted retries
      console.error(`[RateLimit] Exhausted ${maxRetries} retries for ${url}`);
      return {
        ok: false, status: 429, body: null,
        fatal: false, rateLimited: true, retryAfter,
      };
    }

    // ── Other errors (5xx etc) — don't retry but not fatal ──
    const errBody = await res.text().catch(() => "");
    console.error(`[RateLimit] Error ${res.status} on ${options.method || 'GET'} ${url}: ${errBody.slice(0, 200)}`);
    return { ok: false, status: res.status, body: errBody, fatal: false, rateLimited: false };
  }

  // Should not reach here, but just in case
  return { ok: false, status: 0, body: null, fatal: false, rateLimited: false };
}

// ─── OAuth2 Helpers ───

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Generate the OAuth2 authorization URL for a user.
 * Opens Discord's own authorization page (not our page).
 * After user allows, Discord redirects to our callback with a code.
 */
export function getOAuth2Url(userId: string, guildId?: string): string {
  const config = getConfig();
  const clientId = config.clientId;

  if (!clientId) {
    throw new Error("Client ID not set. Run /setup first or set clientId in config.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: config.oauth2.redirectUri,
    response_type: "code",
    scope: "identify guilds.join",
    state: userId,
  });

  if (guildId) {
    params.set("guild_id", guildId);
  }

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * Called by our callback endpoint after user authorizes.
 */
export async function exchangeCode(code: string): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  const config = getConfig();
  const clientId = config.clientId;
  const clientSecret = config.oauth2.clientSecret;

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.oauth2.redirectUri,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${res.status} — ${err}`);
  }

  return res.json();
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  const config = getConfig();

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.oauth2.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${res.status} — ${err}`);
  }

  return res.json();
}

/**
 * Store OAuth2 token in database.
 */
export function storeOAuthToken(
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope: string,
): void {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  getDb().prepare(`
    INSERT OR REPLACE INTO oauth_tokens (user_id, access_token, refresh_token, expires_at, scope)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, accessToken, refreshToken, expiresAt, scope);
}

/**
 * Check if a user has a valid (non-expired) OAuth2 token.
 */
export function hasValidToken(userId: string): boolean {
  const row = getDb().prepare("SELECT expires_at FROM oauth_tokens WHERE user_id = ?").get(userId) as any;
  if (!row) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

/**
 * Get a valid access token for a user. Refreshes if expired.
 * Returns null if no token or refresh fails.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const db = getDb();
  const row = db.prepare("SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE user_id = ?").get(userId) as any;
  if (!row) return null;

  // If not expired, return as-is
  if (new Date(row.expires_at).getTime() > Date.now()) {
    return row.access_token;
  }

  // Try refresh
  if (!row.refresh_token) return null;
  try {
    const newTokens = await refreshAccessToken(row.refresh_token);
    storeOAuthToken(userId, newTokens.access_token, newTokens.refresh_token, newTokens.expires_in, newTokens.scope);
    return newTokens.access_token;
  } catch {
    return null;
  }
}

/**
 * Add a user to a guild using their OAuth2 access token.
 * Uses Discord's PUT /guilds/{guild.id}/members/{user.id} endpoint.
 *
 * Returns:
 *   - { success: true } on 201/204
 *   - { success: false, reason: 'fatal' } on 401/403/404 — stop, don't retry
 *   - { success: false, reason: 'rate_limited' } on 429 after retries exhausted
 *   - { success: false, reason: 'error' } on other failures
 */
export async function addUserToGuild(
  userId: string,
  guildId: string,
  accessToken: string,
  roles?: string[],
): Promise<{ success: boolean; reason?: string; status?: number }> {
  const config = getConfig();

  const body: any = { access_token: accessToken };
  if (roles && roles.length) {
    body.roles = roles;
  }

  const result = await rateLimitedFetch(
    `${DISCORD_API}/guilds/${guildId}/members/${userId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (result.ok) {
    console.log(`✅ Added ${userId} to ${guildId} (${result.status})`);
    return { success: true };
  }

  if (result.fatal) {
    console.warn(`⛔ Fatal error adding ${userId} to ${guildId}: ${result.status}`);
    return { success: false, reason: "fatal", status: result.status };
  }

  if (result.rateLimited) {
    console.warn(`⏳ Rate limited adding ${userId} to ${guildId}`);
    return { success: false, reason: "rate_limited", status: 429 };
  }

  console.error(`❌ Failed to add ${userId} to ${guildId}: ${result.status}`);
  return { success: false, reason: "error", status: result.status };
}
