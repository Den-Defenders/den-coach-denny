/**
 * The OpenAI realtime voice every Denny voice feature uses (Talk with Coach
 * Denny and the CSR post-call coaching). "marin" is one of OpenAI's two
 * newest, most natural-sounding realtime voices.
 *
 * To try a different voice without a code change, set DENNY_VOICE in Vercel
 * (for example "cedar", "echo", "ash", "coral", "sage", "verse") and redeploy.
 */
export const DENNY_VOICE = (process.env.DENNY_VOICE || "marin").trim().toLowerCase();
