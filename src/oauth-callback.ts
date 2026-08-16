// @ts-nocheck — Bun.serve type quirks
import { exchangeCode, storeOAuthToken, truncate } from "./utils.js";

/**
 * Tiny HTTP server that handles the OAuth2 callback.
 * User clicks Authorize → Discord redirects here with a code → we exchange for token.
 * No webpage — just plain text responses.
 *
 * Runs on port 4000 alongside the Discord bot.
 */

const CALLBACK_PORT = 4000;

const server = Bun.serve({
  port: CALLBACK_PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // OAuth2 callback — Discord redirects here after user authorizes
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state"); // state = userId

      if (!code || !state) {
        return new Response("❌ Missing code or state parameter.", { status: 400 });
      }

      try {
        // Exchange code for access token
        const tokens = await exchangeCode(code);

        // Store in database
        storeOAuthToken(state, tokens.access_token, tokens.refresh_token, tokens.expires_in, tokens.scope);

        console.log(`✅ OAuth2 token stored for user ${state}`);

        return new Response(
          `✅ Authorized! You can close this tab now.\n\nCustodian can now add you to servers when needed. Go back to Discord.`,
          { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      } catch (err: any) {
        console.error(`❌ OAuth2 callback error for ${state}:`, err.message);
        return new Response(
          `❌ Authorization failed: ${truncate(err.message, 200)}\n\nTry again or contact an admin.`,
          { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    // 404 for everything else
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🌐 OAuth2 callback server running on port ${CALLBACK_PORT}`);

export { server, CALLBACK_PORT };
