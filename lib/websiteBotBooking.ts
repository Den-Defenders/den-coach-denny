/**
 * lib/websiteBotBooking.ts
 *
 * Phase 2 of the website bot: turning a chat into a real ServiceTitan booking.
 *
 * Flow:
 *   1. The chat model gathers contact details and the qualifying answers, then
 *      calls the prepare_booking tool with the visitor's chosen date + window.
 *   2. The server re-resolves the slot live (lib/websiteBotMcp.ts), runs the
 *      MCP booking tool as a DRY RUN, and returns a PREVIEW plus a signed token.
 *   3. The widget shows the preview with a Confirm button. Only when the
 *      visitor clicks Confirm does the server book, using the token. The model
 *      never books on its own say-so.
 *
 * The token is an HMAC-signed JSON blob (15-minute life). It carries the
 * resolved rep/time and the visitor's details so the confirm step is
 * stateless. It is opaque to the browser, and tampering breaks the signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { BookingCustomer, BookingQualifying, ResolvedSlot } from "@/lib/websiteBotMcp";

export function bookingEnabled(): boolean {
  return (process.env.WEBSITE_BOT_BOOKING_ENABLED || "").trim().toLowerCase() === "true";
}

function signingSecret(): string {
  const secret = (process.env.WEBSITE_BOT_SIGNING_SECRET || "").trim();
  if (!secret || secret.length < 16) {
    throw new Error("WEBSITE_BOT_SIGNING_SECRET is not set (needs 16+ random characters).");
  }
  return secret;
}

// ---------------------------------------------------------------------------
// Input cleaning
// ---------------------------------------------------------------------------

const STATES = new Set(["AZ", "CA", "NV", "OR", "TX", "WA", "ID", "UT", "NM", "CO"]);

export type PreparedBookingInput = {
  customer: BookingCustomer;
  qualifying: BookingQualifying;
  date: string;
  arrivalWindow: string;
  customerNotes?: string;
};

export type ValidationResult =
  | { ok: true; value: PreparedBookingInput }
  | { ok: false; missing: string[] };

function str(value: unknown, max = 200): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? ten : null;
}

export function validateBookingInput(args: Record<string, unknown>): ValidationResult {
  const missing: string[] = [];

  const name = str(args.fullName, 100);
  if (name.split(/\s+/).filter(Boolean).length < 2) missing.push("full name (first and last)");

  const phone = normalizePhone(str(args.phone, 40));
  if (!phone) missing.push("10-digit phone number");

  const emailRaw = str(args.email, 120);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw) ? emailRaw : "";
  if (!email) missing.push("email address");

  const street = str(args.street, 200);
  if (street.length < 3 || !/\d/.test(street)) missing.push("street address with house number");
  const unit = str(args.unit, 50) || undefined;
  const city = str(args.city, 100);
  if (city.length < 2) missing.push("city");
  const state = str(args.state, 2).toUpperCase();
  if (!STATES.has(state)) missing.push("two-letter state");
  const zip = str(args.zip, 10);
  if (!/^\d{5}$/.test(zip)) missing.push("5-digit ZIP");

  const date = str(args.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) missing.push("appointment date");
  const arrivalWindow = str(args.arrivalWindow, 20);
  if (!arrivalWindow) missing.push("arrival window");

  const decisionMakers = str(args.decisionMakers, 500);
  if (!decisionMakers) missing.push("decision-maker answer");

  if (missing.length) return { ok: false, missing };

  const qualifying: BookingQualifying = {
    reason: str(args.reason, 500) || undefined,
    priority: str(args.priority, 500) || undefined,
    otherOptions: str(args.otherOptions, 500) || undefined,
    timeline: str(args.timeline, 500) || undefined,
    entryPoints: str(args.entryPoints, 500) || undefined,
    decisionMakers,
    heardAboutUs: str(args.heardAboutUs, 200) || undefined,
    priceRange: str(args.priceRange, 200) || undefined,
    parking: str(args.parking, 300) || undefined,
    callAttached: "NO - booked through the website chat",
  };

  return {
    ok: true,
    value: {
      customer: { name, phone: phone!, email, street, unit, city, state, zip },
      qualifying,
      date,
      arrivalWindow,
      customerNotes: str(args.notes, 1000) || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Signed preview token
// ---------------------------------------------------------------------------

export type BookingTicket = PreparedBookingInput & {
  slot: ResolvedSlot;
  sessionId: string;
  exp: number; // ms since epoch
};

const TICKET_LIFETIME_MS = 15 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signBookingTicket(ticket: Omit<BookingTicket, "exp">): string {
  const payload = b64url(Buffer.from(JSON.stringify({ ...ticket, exp: Date.now() + TICKET_LIFETIME_MS })));
  const sig = b64url(createHmac("sha256", signingSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyBookingTicket(token: string): BookingTicket | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expected = b64url(createHmac("sha256", signingSecret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as BookingTicket;
    if (!ticket?.exp || ticket.exp < Date.now()) return null;
    return ticket;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What the visitor sees
// ---------------------------------------------------------------------------

export type BookingPreview = {
  name: string;
  address: string;
  date: string;
  weekday: string;
  arrivalWindow: string;
  phoneLast4: string;
  email: string;
};

export function previewFor(input: PreparedBookingInput): BookingPreview {
  const d = new Date(`${input.date}T12:00:00Z`);
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
  const address = [input.customer.street, input.customer.unit ? `#${input.customer.unit}` : "", `${input.customer.city}, ${input.customer.state} ${input.customer.zip}`]
    .filter(Boolean)
    .join(", ")
    .replace(", #", " #");
  return {
    name: input.customer.name,
    address,
    date: input.date,
    weekday,
    arrivalWindow: input.arrivalWindow,
    phoneLast4: input.customer.phone.slice(-4),
    email: input.customer.email || "",
  };
}

// ---------------------------------------------------------------------------
// Slack post for every website booking (optional)
// ---------------------------------------------------------------------------

export async function postBookingToSlack(ticket: BookingTicket, jobNumber: string | undefined, testMode: boolean): Promise<void> {
  const url = (process.env.WEBSITE_BOT_SLACK_WEBHOOK_URL || "").trim();
  if (!url) return;
  const p = previewFor(ticket);
  const q = ticket.qualifying;
  const lines = [
    `${testMode ? "[TEST] " : ""}New sales appointment booked from the website chat`,
    `*${p.name}* - ${p.weekday} ${p.date}, arrival ${p.arrivalWindow}`,
    `${p.address}`,
    `Rep: ${ticket.slot.consultantName}${jobNumber ? ` - Job ${jobNumber}` : ""}`,
    q.reason ? `Why: ${q.reason}` : "",
    q.entryPoints ? `Entry points: ${q.entryPoints}` : "",
    q.decisionMakers ? `Decision makers: ${q.decisionMakers}` : "",
    q.parking ? `Parking/gate: ${q.parking}` : "",
  ].filter(Boolean);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: lines.join("\n") }),
    });
  } catch (error) {
    console.error("Website bot Slack post failed:", error instanceof Error ? error.message : error);
  }
}
