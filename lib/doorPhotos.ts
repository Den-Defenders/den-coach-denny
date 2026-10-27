/**
 * lib/doorPhotos.ts
 *
 * The door photo library the texting bot can send (Steven, 2026-10-27).
 *
 * Owners upload photos on /door-photos (owner-only page). Each photo is stored
 * in Vercel Blob under
 *
 *   door-photos/<category>/<variant>/<name>-<random>.jpg
 *
 * with a long random suffix, so the link works for Twilio and the customer who
 * gets the text, but nobody can browse or guess the library. The folder path
 * IS the label: no database needed. Delete a photo and the bot stops using it.
 *
 * The browser shrinks every photo to text-message size (longest side 1600px,
 * JPEG) before upload, which also strips phone GPS/EXIF data.
 */
import { del, list } from "@vercel/blob";

export const DOOR_PHOTO_CATEGORIES = [
  { key: "vistaluxe", label: "VistaLuxe Storm Doors" },
  { key: "sliding", label: "Sliding Security Door" },
  { key: "artisan", label: "Artisan" },
  { key: "centurion", label: "Centurion" },
  { key: "clearbreeze", label: "ClearBreeze" },
  { key: "window-screens", label: "Security Window Screen" },
  { key: "woodhaven", label: "WoodHaven" },
] as const;

export const DOOR_PHOTO_VARIANTS = [
  { key: "single", label: "Single" },
  { key: "double", label: "Double Doors" },
] as const;

export type DoorPhotoCategory = (typeof DOOR_PHOTO_CATEGORIES)[number]["key"];
export type DoorPhotoVariant = (typeof DOOR_PHOTO_VARIANTS)[number]["key"];

export type DoorPhoto = {
  url: string;
  pathname: string;
  category: DoorPhotoCategory;
  variant: DoorPhotoVariant;
  size: number;
  uploadedAt: string;
};

export const DOOR_PHOTO_PREFIX = "door-photos/";
/** Photos are resized in the browser first; this is a safety limit (Twilio MMS max is 5 MB). */
export const DOOR_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

export function isCategory(value: unknown): value is DoorPhotoCategory {
  return DOOR_PHOTO_CATEGORIES.some((c) => c.key === value);
}

export function isVariant(value: unknown): value is DoorPhotoVariant {
  return DOOR_PHOTO_VARIANTS.some((v) => v.key === value);
}

/** door-photos/<category>/<variant>/<file>.jpg → category + variant, or null for anything else. */
export function parseDoorPhotoPath(pathname: string): { category: DoorPhotoCategory; variant: DoorPhotoVariant } | null {
  const m = /^door-photos\/([a-z-]+)\/([a-z]+)\/[^/]+\.jpe?g$/i.exec(pathname || "");
  if (!m || !isCategory(m[1]) || !isVariant(m[2])) return null;
  return { category: m[1], variant: m[2] };
}

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** Every photo in the library (newest first). */
export async function listDoorPhotos(): Promise<DoorPhoto[]> {
  const photos: DoorPhoto[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: DOOR_PHOTO_PREFIX, limit: 1000, cursor });
    for (const b of page.blobs) {
      const where = parseDoorPhotoPath(b.pathname);
      if (!where) continue;
      photos.push({
        url: b.url,
        pathname: b.pathname,
        ...where,
        size: b.size,
        uploadedAt: new Date(b.uploadedAt).toISOString(),
      });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return photos.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Delete one photo; only paths inside the library are allowed. */
export async function deleteDoorPhoto(url: string): Promise<boolean> {
  let pathname = "";
  try {
    pathname = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    return false;
  }
  if (!parseDoorPhotoPath(pathname)) return false;
  await del(url);
  return true;
}
