/**
 * /api/door-photos (owners only)
 *   GET     list the door photo library
 *   DELETE  { url } remove one photo (the bot stops using it right away)
 */
import { NextResponse } from "next/server";
import { getCurrentAccess } from "@/lib/currentAccess";
import { DOOR_PHOTO_CATEGORIES, DOOR_PHOTO_VARIANTS, blobConfigured, deleteDoorPhoto, listDoorPhotos } from "@/lib/doorPhotos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "private, no-store" };

async function requireOwner() {
  const access = await getCurrentAccess();
  return access?.role === "owner" ? access : null;
}

export async function GET() {
  if (!await requireOwner()) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  if (!blobConfigured()) {
    return NextResponse.json({ error: "Photo storage (Vercel Blob) isn't connected." }, { status: 500, headers: NO_STORE });
  }
  try {
    const photos = await listDoorPhotos();
    return NextResponse.json({ categories: DOOR_PHOTO_CATEGORIES, variants: DOOR_PHOTO_VARIANTS, photos }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Couldn't load photos: ${message}` }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE(req: Request) {
  const access = await requireOwner();
  if (!access) return NextResponse.json({ error: "Owners only." }, { status: 403, headers: NO_STORE });
  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = typeof body.url === "string" ? body.url : "";
  try {
    const ok = await deleteDoorPhoto(url);
    if (!ok) return NextResponse.json({ error: "That isn't a door photo." }, { status: 400, headers: NO_STORE });
    console.info("Door photo deleted", { by: access.email, url });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `Couldn't delete: ${message}` }, { status: 500, headers: NO_STORE });
  }
}
