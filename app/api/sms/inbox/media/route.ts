/**
 * GET /api/sms/inbox/media?id=<message id>&i=<photo number>
 *
 * Shows a photo a customer texted us. Twilio keeps those behind our Twilio
 * login, so this route fetches it with the Account SID + Auth Token (server
 * side only) and passes the picture through. It only ever fetches the exact
 * Twilio media link saved on that inbound text, never a link from the browser.
 */
import { canAccessTextingInbox } from "@/lib/access";
import { getCurrentAccess } from "@/lib/currentAccess";
import { inboundMediaUrl, smsDatabaseConfigured } from "@/lib/sms/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TWILIO_MEDIA = /^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[0-9a-f]{32}\/Messages\/MM[0-9a-f]{32}\/Media\/ME[0-9a-f]{32}$/i;
const MAX_BYTES = 6 * 1024 * 1024; // Twilio MMS pictures are 5 MB or less

function plain(message: string, status: number) {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" } });
}

export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!access || !canAccessTextingInbox(access)) return plain("Forbidden", 403);
  if (!smsDatabaseConfigured()) return plain("Texting database isn't set up.", 500);

  const url = new URL(request.url);
  const id = Number.parseInt(url.searchParams.get("id") || "", 10);
  const index = Number.parseInt(url.searchParams.get("i") || "0", 10);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(index) || index < 0 || index > 9) return plain("Bad request", 400);

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!accountSid || !authToken) return plain("Twilio isn't set up.", 500);

  try {
    const mediaUrl = await inboundMediaUrl(id, index);
    if (!mediaUrl || !TWILIO_MEDIA.test(mediaUrl) || !mediaUrl.includes(`/Accounts/${accountSid}/`)) return plain("Not found", 404);

    const response = await fetch(mediaUrl, {
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || !response.body) return plain("Twilio didn't return the photo (it may have been deleted).", 502);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) return plain("Photo is too large to show.", 502);

    const type = (response.headers.get("content-type") || "").toLowerCase();
    const isImage = /^image\/(jpeg|png|gif|webp|heic|heif|bmp)$/.test(type.split(";")[0].trim());
    return new Response(response.body, {
      status: 200,
      headers: {
        "Content-Type": isImage ? type : "application/octet-stream",
        // Anything that isn't a plain picture downloads instead of opening in the page.
        ...(isImage ? {} : { "Content-Disposition": `attachment; filename="text-attachment-${id}-${index}"` }),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    console.error("SMS inbox media failed:", error instanceof Error ? error.message : error);
    return plain("Could not load the photo.", 502);
  }
}
