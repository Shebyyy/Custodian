// @ts-nocheck — Bun.serve type quirks
import { exchangeCode, storeOAuthToken, truncate } from "./utils.js";
import { notifyAuthorized } from "./modules/verification.js";

/**
 * Tiny HTTP server that handles the OAuth2 callback.
 * User clicks Authorize → Discord redirects here with a code → we exchange for token → fetch userId from token.
 * No webpage — just plain text responses.
 *
 * Runs on port 4000 alongside the Discord bot.
 */

const CALLBACK_PORT = parseInt(process.env.OAUTH_CALLBACK_PORT || "4000", 10);

let server: any;

try {
  server = Bun.serve({
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

        if (!code) {
          return new Response("❌ Missing code parameter.", { status: 400 });
        }

        try {
          // Exchange code for access token
          const tokens = await exchangeCode(code);

          // Get user ID from the access token
          const userRes = await fetch("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          const userData = await userRes.json() as any;

          if (!userData.id) {
            return new Response("❌ Could not identify your Discord account.", { status: 400 });
          }

          // Store in database using the actual user ID from Discord
          storeOAuthToken(userData.id, tokens.access_token, tokens.refresh_token, tokens.expires_in, tokens.scope);

          console.log(`✅ OAuth2 token stored for user ${userData.username} (${userData.id})`);

          // Update the user's pending ephemeral message with the Verify Me button
          notifyAuthorized(userData.id).catch((err: any) => {
            console.warn(`[OAuth] notifyAuthorized failed for ${userData.id}:`, err?.message);
          });

          return new Response(
            `✅ Authorized as **${userData.username}**! You can close this tab now.\n\nCustodian can now add you to servers when needed. Go back to Discord.`,
            { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
          );
        } catch (err: any) {
          console.error(`❌ OAuth2 callback error:`, err.message);
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
} catch (err: any) {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ OAuth2 callback server failed — port ${CALLBACK_PORT} is already in use.`);
    console.error("   Another instance of the bot may be running. Kill it and try again.");
  } else {
    console.error(`❌ OAuth2 callback server failed: ${err.message}`);
  }
}

export { server, CALLBACK_PORT };
