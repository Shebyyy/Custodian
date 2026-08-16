import { getConfig } from "./config.js";
import { getDb } from "./db.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
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
 */
export async function addUserToGuild(
  userId: string,
  guildId: string,
  accessToken: string,
  roles?: string[],
): Promise<boolean> {
  const config = getConfig();

  const body: any = { access_token: accessToken };
  if (roles && roles.length) {
    body.roles = roles;
  }

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // 201 = added, 204 = already in guild (no content change)
  if (res.status === 201 || res.status === 204) {
    return true;
  }

  // 401 = token expired, 403 = no permission, 404 = unknown user
  const err = await res.text();
  console.error(`Failed to add ${userId} to ${guildId}: ${res.status} — ${err}`);
  return false;
}
