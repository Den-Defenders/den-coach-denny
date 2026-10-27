"use client";

import { upload } from "@vercel/blob/client";
import { useCallback, useEffect, useState } from "react";

type Category = { key: string; label: string };
type Variant = { key: string; label: string };
type Photo = { url: string; pathname: string; category: string; variant: string; size: number; uploadedAt: string };

/** Text-message size: longest side 1600px, JPEG ~80%. Re-encoding also drops phone GPS/EXIF data. */
const MAX_SIDE = 1600;
const QUALITY = 0.82;

async function shrinkToJpeg(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name}: this browser can't open that file. Use a JPG or PNG (iPhone HEIC photos: export as JPG first).`);
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser couldn't resize the photo.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
  if (!blob) throw new Error(`${file.name}: couldn't convert to JPEG.`);
  return blob;
}

/** "09 - clay - storm-09_ST0020.jpg" → "09-clay-storm-09-st0020" (keeps the color name, readable later). */
function slug(name: string): string {
  return name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "photo";
}

/** Readable label from the stored name (drops Blob's random suffix). */
function photoLabel(pathname: string): string {
  const file = pathname.split("/").pop() || "";
  return file.replace(/\.jpe?g$/i, "").replace(/-[A-Za-z0-9]{20,}$/, "").replace(/-/g, " ");
}

export default function DoorPhotos() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setError("");
    const res = await fetch("/api/door-photos", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data?.error || `Couldn't load photos (HTTP ${res.status}).`); return; }
    setCategories(data.categories || []);
    setVariants(data.variants || []);
    setPhotos(data.photos || []);
  }, []);

  useEffect(() => {
    // Fetch the library once when the page opens (same pattern as the Texting page).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function onFiles(category: string, variant: string, list: FileList | null) {
    const files = Array.from(list || []);
    if (!files.length) return;
    const key = `${category}/${variant}`;
    setBusy(key);
    let done = 0;
    const problems: string[] = [];
    for (const file of files) {
      setStatus(`Uploading ${done + 1} of ${files.length}…`);
      try {
        const jpeg = await shrinkToJpeg(file);
        await upload(`door-photos/${category}/${variant}/${slug(file.name)}.jpg`, jpeg, {
          access: "public",
          contentType: "image/jpeg",
          handleUploadUrl: "/api/door-photos/upload",
        });
        done++;
      } catch (e) {
        problems.push(e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(null);
    setStatus(`Uploaded ${done} of ${files.length}.${problems.length ? ` Problems: ${problems.join(" | ")}` : ""}`);
    await load();
  }

  async function remove(photo: Photo) {
    if (!window.confirm(`Delete "${photoLabel(photo.pathname)}"? The bot stops sending it right away.`)) return;
    const res = await fetch("/api/door-photos", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: photo.url }),
    });
    const data = await res.json().catch(() => ({}));
    setStatus(res.ok ? "Photo deleted." : data?.error || "Couldn't delete.");
    await load();
  }

  return (
    <div className="team-page">
      <section className="surface team-form">
        <h2>Door photos the texting bot can send</h2>
        <p className="team-hint">
          Only owners can see this page. Each photo gets a hidden public link, so the bot can text it to a customer, but nobody can browse the library.
          Photos are shrunk to text-message size when you upload them.
        </p>
        <p className="team-hint">
          ⚠ Only upload photos that are OK to send to any customer: no house numbers, faces, license plates or addresses.
        </p>
        <div className="hero-actions" style={{ marginTop: 10 }}>
          <button className="btn btn-outline" onClick={() => void load()}>Refresh</button>
          <a className="btn btn-outline" href="/sms-test">Back to Texting</a>
        </div>
        {error && <div className="notice" style={{ marginTop: 12 }}>{error}</div>}
        {status && <div className="notice" style={{ marginTop: 12 }}>{status}</div>}
      </section>

      {categories.map((cat) => (
        <section key={cat.key} className="surface team-list">
          <h2>{cat.label}</h2>
          {variants.map((v) => {
            const items = photos.filter((p) => p.category === cat.key && p.variant === v.key);
            const key = `${cat.key}/${v.key}`;
            return (
              <div key={v.key} style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <strong>{v.label}</strong>
                  <span className="team-hint">{items.length} photo{items.length === 1 ? "" : "s"}</span>
                  <label className="btn btn-teal" style={{ cursor: busy ? "wait" : "pointer", opacity: busy ? 0.6 : 1 }}>
                    {busy === key ? "Uploading…" : "Add photos"}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={Boolean(busy)}
                      style={{ display: "none" }}
                      onChange={(e) => { void onFiles(cat.key, v.key, e.target.files); e.target.value = ""; }}
                    />
                  </label>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginTop: 10 }}>
                  {items.map((p) => (
                    <figure key={p.url} style={{ margin: 0 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.url} alt={photoLabel(p.pathname)} loading="lazy"
                        style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", borderRadius: 8, display: "block" }} />
                      <figcaption style={{ fontSize: 12, marginTop: 4, display: "flex", justifyContent: "space-between", gap: 6 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{photoLabel(p.pathname)}</span>
                        <button onClick={() => void remove(p)} style={{ border: "none", background: "none", color: "#b42318", cursor: "pointer", padding: 0 }}>
                          Delete
                        </button>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
