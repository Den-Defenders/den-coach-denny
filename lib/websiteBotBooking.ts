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
import type { BookingCustomer, BookingQualifying, ResolvedSlot, ReturningCustomer } from "@/lib/websiteBotMcp";

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

export type ExistingCustomerRef = { customerId: number; locationId?: number; firstName: string };

export type PreparedBookingInput = {
  customer: BookingCustomer;
  qualifying: BookingQualifying;
  date: string;
  arrivalWindow: string;
  customerNotes?: string;
  /** Present when the visitor was matched to an existing ServiceTitan customer. */
  existing?: ExistingCustomerRef;
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

  // Returning customer: the model passes back the opaque customerRef it got
  // from lookup_returning_customer. Verify it; never trust a raw ID.
  let existing: ExistingCustomerRef | undefined;
  if (typeof args.customerRef === "string" && args.customerRef) {
    const ref = verifyCustomerRef(args.customerRef);
    if (!ref) missing.push("a valid customerRef (run lookup_returning_customer again)");
    else existing = ref;
  }

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

  // The qualifying answers fill the standard Den Defenders job summary. All of
  // them are required so the office gets the same picture a phone booking gives.
  const reason = str(args.reason, 500);
  if (!reason) missing.push("Q1: what had them looking into our products (specific concern or upgrade)");
  const priority = str(args.priority, 500);
  if (!priority) missing.push("Q2: what matters most (security, appearance, long-term value)");
  const otherOptions = str(args.otherOptions, 500);
  if (!otherOptions) missing.push("Q3: looked at other options or just starting");
  const timeline = str(args.timeline, 500);
  if (!timeline) missing.push("Q4: fairly soon or gathering options");
  const entryPoints = str(args.entryPoints, 500);
  if (!entryPoints) missing.push("Q5: which entry points (front, side, back, slider, window)");
  const decisionMakers = str(args.decisionMakers, 500);
  if (!decisionMakers) missing.push("Q6: sole decision-maker or reviewing with someone else");
  const heardAboutUs = str(args.heardAboutUs, 200);
  if (!heardAboutUs) missing.push("how they heard about Den Defenders");
  const priceRange = str(args.priceRange, 200);
  if (!priceRange) missing.push("the price range you quoted");
  const parking = str(args.parking, 300);
  if (!parking) missing.push("gate/parking instructions ('None' is fine)");

  if (missing.length) return { ok: false, missing };

  const qualifying: BookingQualifying = {
    reason,
    priority,
    otherOptions,
    timeline,
    entryPoints,
    decisionMakers,
    heardAboutUs,
    priceRange,
    parking,
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
      existing,
    },
  };
}

// ---------------------------------------------------------------------------
// Signed customer reference (returning customers)
// ---------------------------------------------------------------------------

const CUSTOMER_REF_LIFETIME_MS = 60 * 60 * 1000;

export function signCustomerRef(customer: ReturningCustomer): string {
  const payload = b64url(Buffer.from(JSON.stringify({
    t: "cust",
    customerId: customer.customerId,
    locationId: customer.locationId,
    firstName: customer.firstName,
    exp: Date.now() + CUSTOMER_REF_LIFETIME_MS,
  })));
  const sig = b64url(createHmac("sha256", signingSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyCustomerRef(token: string): ExistingCustomerRef | null {
  const [payload, sig] = (token || "").split(".");
  if (!payload || !sig) return null;
  const expected = b64url(createHmac("sha256", signingSecret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      t?: string; customerId?: number; locationId?: number; firstName?: string; exp?: number;
    };
    if (data.t !== "cust" || !data.customerId || !data.exp || data.exp < Date.now()) return null;
    return { customerId: data.customerId, locationId: data.locationId, firstName: data.firstName || "" };
  } catch {
    return null;
  }
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
  returning: boolean;
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
    returning: Boolean(input.existing),
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
// Chat transcript -> job note
// ---------------------------------------------------------------------------

const NOTE_MAX = 4000; // add_job_note limit on the MCP

export function transcriptNote(
  messages: { role: "user" | "assistant"; content: string }[],
  preview: BookingPreview,
  testMode: boolean
): string {
  const header = `${testMode ? "[TEST] " : ""}Website chat transcript (booked online by the visitor)\n` +
    `${preview.weekday} ${preview.date}, arrival ${preview.arrivalWindow} - ${preview.name}\n\n`;
  const lines = messages.map((m) => `${m.role === "user" ? "Visitor" : "Denny"}: ${m.content.replace(/\s+/g, " ").trim()}`);
  let body = lines.join("\n");
  const room = NOTE_MAX - header.length - 40;
  if (body.length > room) {
    // Keep the end of the conversation (details + chosen time live there).
    body = "[earlier messages trimmed]\n" + body.slice(body.length - room);
  }
  return header + body;
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
    `Rep: ${ticket.slot.consultantName}${jobNumber ? ` - Job ${jobNumber}` : ""}${ticket.existing ? " - returning customer" : ""}`,
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
