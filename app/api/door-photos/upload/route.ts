/**
 * /api/door-photos/upload (owners only)
 *
 * Hands the browser a short-lived Vercel Blob upload token for ONE door photo.
 * The photo goes straight from the browser to Blob (no 4.5 MB server limit).
 * Only JPEGs inside door-photos/<category>/<variant>/ are allowed, and Blob adds
 * a random suffix so the public link can't be guessed.
 */
import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getCurrentAccess } from "@/lib/currentAccess";
import { DOOR_PHOTO_MAX_BYTES, parseDoorPhotoPath } from "@/lib/doorPhotos";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const access = await getCurrentAccess();
  if (access?.role !== "owner") return NextResponse.json({ error: "Owners only." }, { status: 403 });
  try {
    const body = (await req.json()) as HandleUploadBody;
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!parseDoorPhotoPath(pathname)) throw new Error("Pick a category, then upload a JPEG photo.");
        return {
          allowedContentTypes: ["image/jpeg"],
          maximumSizeInBytes: DOOR_PHOTO_MAX_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ by: access.email || "owner" }),
        };
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
