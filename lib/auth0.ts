import { Auth0Client } from "@auth0/nextjs-auth0/server";

// Sessions: stay signed in for up to 400 days (the longest a browser keeps a
// cookie), and every visit pushes the expiry out again. Removing someone on
// the Team page (or turning them off) still blocks them on their next click,
// because roles are checked on every request.
const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;

export const auth0 = new Auth0Client({
  authorizationParameters: {
    audience: "https://servicetitan-mcp-alpha.vercel.app/mcp",
    // offline_access = refresh token, so the ServiceTitan connection keeps
    // working long after the first sign-in without asking again.
    scope:
      "openid profile email offline_access servicetitan.read",
  },
  session: {
    rolling: true,
    absoluteDuration: FOUR_HUNDRED_DAYS,
    inactivityDuration: FOUR_HUNDRED_DAYS,
  },
  // Denny only uses the login token on the server. Turning off the built-in
  // /auth/access-token address stops anyone copying their token out of the
  // browser and using it to call the ServiceTitan MCP directly.
  enableAccessTokenEndpoint: false,
});
