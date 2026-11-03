/**
 * lib/sms/drip.ts
 *
 * The standard new-lead drip (build step 5): Melanie's "New Leads Campaign
 * Script" with the audit edits she asked for (no Josh/Joshua name, STOP
 * instead of END, no emojis, no invented availability or install timeline,
 * corrected warranty wording). Steven, 2026-11-03: live as Melanie wrote it,
 * no separate approval step.
 *
 * How it runs:
 *   - /api/leads starts the drip (drip_status 'active', step 0 due now) and
 *     sends the welcome right away (8 AM - 8 PM their time).
 *   - The timer (/api/sms/timer, GitHub Actions every 15 minutes) sends each
 *     step when it's due. Every send goes through the ONE send helper
 *     (lib/sms/send.ts): opt-outs, consent, 9 AM - 5 PM, holidays, caps.
 *   - ServiceTitan exclusions (lib/sms/stCheck.ts) are checked before every
 *     drip text (result reused for 12 hours).
 *   - The drip stops for good when they reply (the AI takes over), opt out,
 *     say not interested, a person takes over, a booking request exists, or a
 *     person clicks "Stop drip" in the inbox.
 *   - $400 / financing steps are "marketing": skipped while
 *     SMS_PROMO_TEXTS_ENABLED is off.
 *   - On/off for everything: SMS_DRIP_ENABLED=true.
 */
import { after } from "next/server";
import { holidayName, localTime, safeTimeZone, withinSendingHours } from "@/lib/sms/rules";
import { promoTextsEnabled, sendSms, smsNow, type SendPurpose } from "@/lib/sms/send";
import { checkServiceTitan, freshCheck, stCheckSummary, type StCheck } from "@/lib/sms/stCheck";
import { audit, findOptOut, setHandoff, smsDb } from "@/lib/sms/store";

export const DRIP_SENDER = "drip";

export type DripStep = {
  /** "Day 1" = the day the welcome went out. */
  day: number;
  /** "now" = the welcome; "+10m" = 10 minutes after the last text; else local "HH:MM". */
  at: "now" | "+10m" | string;
  purpose: SendPurpose;
  /** {first} = their first name (falls back to "there" or drops it). */
  body: string;
};

const PROMO_FOOTNOTE = "*May be used with approved financing. Cannot be combined with other offers. Restrictions apply.";

export const DRIP_STEPS: DripStep[] = [
  { day: 1, at: "now", purpose: "care", body:
    "Hi {first}! This is Den Defenders Security Doors. Thanks for reaching out! I'm excited to help get your free in-home consultation scheduled and answer any questions you have.\n\nReply STOP to opt out." },
  { day: 1, at: "+10m", purpose: "care", body:
    "With Den Defenders, your consultation is 100% free and happens right at your home. We'll handle measurements, show colors and product samples, and create your quote on-site.\n\nWould you like me to check our next available times in your area?" },
  { day: 2, at: "10:00", purpose: "care", body:
    "Hi {first}! I know fitting another appointment into your week can be tough, so we keep consultations simple and aim to finish in under 45 minutes.\n\nDo mornings or afternoons work best?" },
  { day: 3, at: "11:15", purpose: "care", body:
    "Did you know that Den Defenders builds every door ourselves?\n\nFrom design to installation and warranty support, you work with one local team.\n\nHow soon are you hoping to have yours installed?" },
  { day: 4, at: "16:15", purpose: "care", body:
    "Hey {first}! Want me to check our open consultation times in your area?\n\nJust reply with the day that's easiest for you and I'll look." },
  { day: 6, at: "10:15", purpose: "care", body:
    "{first}, still looking for the perfect door design? With Den Defenders, you're not limited to what's in a catalog.\n\nSend us a photo, describe your idea, or even sketch it out! A few ideas we've brought to life:\n\n- A family name or initial\n- A favorite sports team\n- A city skyline or local landmark\n- A pet or favorite animal\n\nWhat would you love to put on your door?" },
  { day: 9, at: "13:15", purpose: "care", body:
    "{first}, with Den Defenders you're getting more than a door. You're getting a custom-fit home upgrade that's professionally installed and built to last for decades.\n\nEvery door is backed by our 10-year workmanship warranty and our Lifetime No Break-In Guarantee.\n\nReply READY and I'll share more about what makes our doors a lasting investment." },
  { day: 11, at: "09:15", purpose: "care", body:
    "Hi {first}, I understand that choosing a security door takes some thought. Are there any questions I can help answer while you're comparing options? I'm happy to send examples or details if that makes it easier." },
  { day: 14, at: "15:45", purpose: "marketing", body:
    `Great news, {first}! This week only, you can save $400 on a custom Den Defenders Security Door.\n\nAs a local company, we understand that home upgrades can feel like an investment, and we want to make this a little easier. Would you like me to check our upcoming consultation openings?\n\n${PROMO_FOOTNOTE}` },
  { day: 17, at: "12:30", purpose: "marketing", body:
    `Hi {first}, did you know you may qualify for $0 down, 0% interest financing with no payments for 12 months, on approved credit? That means you can lock in the $400 savings now without having to pay for your project right away.*\n\nIs that something you'd be interested in exploring?\n\n${PROMO_FOOTNOTE}` },
  { day: 19, at: "09:45", purpose: "marketing", body:
    `{first}, there are only 48 hours left to save $400 on a Den Defenders Security Door.\n\nIf this project is still on your radar, this is the best time to lock in the lowest price. Reply YES to claim.\n\n${PROMO_FOOTNOTE}` },
  { day: 25, at: "14:15", purpose: "care", body:
    "Hi {first}, I wanted to check in on your security door project.\n\nYou can reply with:\n1 Still interested\n2 Maybe later\n3 Already took care of it" },
  { day: 30, at: "10:45", purpose: "care", body:
    "Hey {first}! What day this week works best for a quick call to go over your security door project?" },
  { day: 35, at: "11:30", purpose: "care", body:
    "Hi {first}, I wanted to make sure we didn't leave you with any unanswered questions.\n\nIs there anything about the price, timing, or process that you'd like me to clear up?" },
  { day: 45, at: "13:45", purpose: "care", body:
    "Hey {first}! We've completed a few beautiful security door installations recently, and seeing real homes can make it easier to explore your options.\n\nWant me to text you a couple photos for design inspiration?" },
  { day: 60, at: "09:45", purpose: "care", body:
    "Hi {first}, I don't want to keep reaching out if your timing has changed.\n\nShould I close your request for now, or would you prefer that I check back in a few months?" },
];

/** Minimum time between two drip texts (except the "+10 minutes" one). */
export const MIN_GAP_MS = 3 * 60 * 60 * 1000;
/** A run "leases" a lead for this long so two timers never send the same step. */
const LEASE_MS = 5 * 60 * 1000;

export function dripEnabled(): boolean {
  return (process.env.SMS_DRIP_ENABLED || "").trim().toLowerCase() === "true";
}

/** "STEVEN" / "steven" -> "Steven"; mixed case is left alone. */
export function niceFirstName(name: string | null | undefined): string | null {
  const n = (name || "").replace(/[^\p{L}\p{M}'\- ]/gu, "").trim().split(/\s+/)[0] || "";
  if (!n || n.length > 30) return null;
  if (n === n.toUpperCase() || n === n.toLowerCase()) return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
  return n;
}

/** Fill {first}. With no name: "Hi there!", "Great news!", "Still looking…". */
export function renderDrip(body: string, firstName: string | null): string {
  if (firstName) return body.replace(/\{first\}/g, firstName);
  return body
    .replace(/^\{first\}, (\w)/, (_, c: string) => c.toUpperCase())
    .replace(/, \{first\}!/g, "!")
    .replace(/\{first\}/g, "there");
}

// ---------------------------------------------------------------------------
// Time math (customer's time zone)
// ---------------------------------------------------------------------------

/** UTC instant for a wall-clock time in a time zone (DST-safe). */
export function zonedTime(dateYmd: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const lt = localTime(new Date(guess), timeZone);
    const asUtc = Date.UTC(lt.year, lt.month - 1, lt.day, lt.hour, lt.minute);
    guess += Date.UTC(y, m - 1, d, hh, mm) - asUtc;
  }
  return new Date(guess);
}

export function localYmd(at: Date, timeZone: string): string {
  const lt = localTime(at, timeZone);
  return `${lt.year}-${String(lt.month).padStart(2, "0")}-${String(lt.day).padStart(2, "0")}`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Move a time forward into the send window (welcome 8 AM - 8 PM, others 9 AM - 5 PM), skipping holidays. */
export function intoWindow(at: Date, kind: "welcome" | "automated", timeZone: string): Date {
  const startHour = kind === "welcome" ? "08:00" : "09:00";
  let t = at;
  for (let i = 0; i < 10; i++) {
    const lt = localTime(t, timeZone);
    if (holidayName(lt)) {
      t = zonedTime(addDays(localYmd(t, timeZone), 1), startHour, timeZone);
      continue;
    }
    if (withinSendingHours(kind, lt)) return t;
    const ymd = localYmd(t, timeZone);
    const startToday = zonedTime(ymd, startHour, timeZone);
    t = t < startToday ? startToday : zonedTime(addDays(ymd, 1), startHour, timeZone);
  }
  return t;
}

/** When step `index` is due, given Day 1's date and when the last drip text went out. */
export function dueTime(index: number, day1: string, lastSentAt: Date, timeZone: string): Date {
  const step = DRIP_STEPS[index];
  const kind = index === 0 ? "welcome" : "automated";
  if (step.at === "now") return intoWindow(lastSentAt, kind, timeZone);
  if (step.at === "+10m") return intoWindow(new Date(lastSentAt.getTime() + 10 * 60 * 1000), kind, timeZone);
  const planned = zonedTime(addDays(day1, step.day - 1), step.at, timeZone);
  const earliest = new Date(lastSentAt.getTime() + MIN_GAP_MS);
  return intoWindow(planned > earliest ? planned : earliest, kind, timeZone);
}

// ---------------------------------------------------------------------------
// Running the drip
// ---------------------------------------------------------------------------

type DripRow = {
  id: number;
  phone: string;
  timeZone: string;
  firstName: string | null;
  botStatus: string;
  leadStatus: string | null;
  hasBooking: boolean;
  step: number;
  nextAt: Date | null;
  day1: string | null;
  startedAt: Date | null;
  lastSentAt: Date | null;
  stCheck: unknown;
  stBypass: boolean;
  repliedAfterStart: boolean;
};

async function loadDrip(phone: string): Promise<DripRow | null> {
  const sql = await smsDb();
  const rows = await sql`SELECT v.id, v.phone, v.bot_status, v.lead_status, (v.booking_request IS NOT NULL) AS has_booking,
      v.drip_status, v.drip_step, v.drip_next_at, v.drip_day1, v.drip_started_at, v.drip_last_sent_at, v.st_check, v.st_test_bypass,
      c.time_zone, c.first_name,
      EXISTS (SELECT 1 FROM sms_messages m WHERE m.conversation_id = v.id AND m.direction = 'inbound'
        AND v.drip_started_at IS NOT NULL AND m.created_at > v.drip_started_at) AS replied
    FROM sms_conversations v JOIN sms_contacts c ON c.phone = v.phone
    WHERE v.phone = ${phone} AND v.drip_status = 'active'`;
  const r = rows[0];
  if (!r) return null;
  const d = (v: unknown) => (v == null ? null : new Date(v as string));
  return {
    id: Number(r.id),
    phone: String(r.phone),
    timeZone: safeTimeZone(String(r.time_zone || "")),
    firstName: niceFirstName(r.first_name as string),
    botStatus: String(r.bot_status || "on"),
    leadStatus: (r.lead_status as string) ?? null,
    hasBooking: r.has_booking === true,
    step: Number(r.drip_step || 0),
    nextAt: d(r.drip_next_at),
    day1: (r.drip_day1 as string) ?? null,
    startedAt: d(r.drip_started_at),
    lastSentAt: d(r.drip_last_sent_at),
    stCheck: r.st_check ?? null,
    stBypass: r.st_test_bypass === true,
    repliedAfterStart: r.replied === true,
  };
}

/** Stop a lead's drip for good. by = who/what stopped it. */
export async function stopDrip(phone: string, reason: string, by: string, at: Date = smsNow()): Promise<boolean> {
  const sql = await smsDb();
  const rows = await sql`UPDATE sms_conversations SET drip_status = 'stopped', drip_stop_reason = ${reason.slice(0, 120)},
      drip_stopped_at = ${at.toISOString()}::timestamptz, drip_stopped_by = ${by.slice(0, 120)}, drip_next_at = NULL, updated_at = now()
    WHERE phone = ${phone} AND drip_status = 'active' RETURNING id`;
  if (rows.length) await audit({ phone, action: "drip_stopped", reason, actor: by });
  return rows.length > 0;
}

async function setNext(id: number, step: number, nextAt: Date | null, extra: { day1?: string; lastSentAt?: Date } = {}) {
  const sql = await smsDb();
  if (nextAt === null) {
    await sql`UPDATE sms_conversations SET drip_status = 'done', drip_step = ${step}, drip_next_at = NULL,
        drip_last_sent_at = coalesce(${extra.lastSentAt?.toISOString() ?? null}::timestamptz, drip_last_sent_at), updated_at = now()
      WHERE id = ${id}`;
    return;
  }
  await sql`UPDATE sms_conversations SET drip_step = ${step}, drip_next_at = ${nextAt.toISOString()}::timestamptz,
      drip_day1 = coalesce(${extra.day1 ?? null}, drip_day1),
      drip_last_sent_at = coalesce(${extra.lastSentAt?.toISOString() ?? null}::timestamptz, drip_last_sent_at), updated_at = now()
    WHERE id = ${id}`;
}

/** Retry the same step later (blocked by hours, caps, a failed ServiceTitan check…). */
async function retryLater(row: DripRow, at: Date) {
  const sql = await smsDb();
  await sql`UPDATE sms_conversations SET drip_next_at = ${at.toISOString()}::timestamptz, updated_at = now() WHERE id = ${row.id}`;
}

async function saveStCheck(id: number, check: StCheck) {
  const sql = await smsDb();
  await sql`UPDATE sms_conversations SET st_check = ${JSON.stringify(check)}::jsonb, st_checked_at = ${check.checkedAt}::timestamptz,
      updated_at = now() WHERE id = ${id}`;
}

export type DripOutcome =
  | "sent" | "skipped_promo" | "stopped" | "retry_later" | "not_due" | "busy" | "done" | "drip_off" | "not_active";

const RETRY_BLOCKS = new Set([
  "outside_hours", "holiday", "contact_hourly_cap", "contact_daily_cap", "automated_daily_cap", "system_daily_cap", "sending_disabled",
  "twilio_not_configured", "database_not_configured",
]);
const HOUR = 60 * 60 * 1000;

/**
 * Send this lead's next drip text if it's due. Safe to call from two places at
 * once (a short lease makes the second call a no-op).
 */
export async function processDrip(phone: string, now: Date = smsNow()): Promise<DripOutcome> {
  if (!dripEnabled()) return "drip_off";
  const row = await loadDrip(phone);
  if (!row) return "not_active";
  if (row.nextAt && row.nextAt > now) return "not_due";

  // Lease: only one run may work on this lead right now.
  const sql = await smsDb();
  const leased = await sql`UPDATE sms_conversations SET drip_next_at = ${new Date(now.getTime() + LEASE_MS).toISOString()}::timestamptz
    WHERE id = ${row.id} AND drip_status = 'active'
      AND (drip_next_at IS NULL OR drip_next_at = ${row.nextAt ? row.nextAt.toISOString() : null}::timestamptz)
    RETURNING id`;
  if (!leased.length) return "busy";

  // Stop rules (for good).
  if (await findOptOut(phone)) return (await stopDrip(phone, "opted out", "system", now)) ? "stopped" : "stopped";
  if (row.repliedAfterStart) return (await stopDrip(phone, "they replied (AI took over)", "system", now), "stopped");
  if (row.leadStatus === "not_interested") return (await stopDrip(phone, "not interested", "system", now), "stopped");
  if (row.botStatus === "paused") return (await stopDrip(phone, "a person took over", "system", now), "stopped");
  if (row.hasBooking) return (await stopDrip(phone, "booking requested", "system", now), "stopped");
  if (row.step >= DRIP_STEPS.length) {
    await setNext(row.id, row.step, null);
    return "done";
  }

  // ServiceTitan exclusions (reused for 12 hours).
  if (!row.stBypass) {
    let check = freshCheck(row.stCheck, now);
    if (!check) {
      check = await checkServiceTitan(phone, now);
      await saveStCheck(row.id, check);
    }
    if (!check.ok) {
      await audit({ phone, action: "drip_st_check_failed", reason: check.error || "error", actor: DRIP_SENDER });
      await retryLater(row, new Date(now.getTime() + HOUR));
      return "retry_later";
    }
    if (check.blocked) {
      await stopDrip(phone, stCheckSummary(check).slice(0, 120), "servicetitan", now);
      await setHandoff(phone, "st_excluded", `${stCheckSummary(check)}. No automated texts. A person decides whether to reach out.`, now, { keepAi: true });
      return "stopped";
    }
  }

  const step = DRIP_STEPS[row.step];
  const kind = row.step === 0 ? "welcome" : "automated";

  // Promo steps wait behind the promo switch: skip them (the drip goes on).
  if (step.purpose === "marketing" && !promoTextsEnabled()) {
    await audit({ phone, action: "drip_step_skipped", reason: "promo texts off", detail: { step: row.step, day: step.day }, actor: DRIP_SENDER });
    const next = row.step + 1;
    const base = row.lastSentAt || now;
    await setNext(row.id, next, next >= DRIP_STEPS.length ? null : dueTime(next, row.day1 || localYmd(now, row.timeZone), base, row.timeZone));
    return "skipped_promo";
  }

  const result = await sendSms({
    to: phone,
    body: renderDrip(step.body, row.firstName),
    kind,
    purpose: step.purpose,
    sentBy: DRIP_SENDER,
  });

  if (result.ok) {
    const day1 = row.day1 || localYmd(now, row.timeZone);
    const next = row.step + 1;
    await audit({ phone, action: "drip_sent", reason: `step ${row.step + 1} of ${DRIP_STEPS.length}`, detail: { day: step.day, messageId: result.messageId }, actor: DRIP_SENDER });
    await setNext(row.id, next, next >= DRIP_STEPS.length ? null : dueTime(next, day1, now, row.timeZone), { day1, lastSentAt: now });
    return "sent";
  }

  if (RETRY_BLOCKS.has(result.reason)) {
    const later = result.reason === "outside_hours" || result.reason === "holiday"
      ? intoWindow(new Date(now.getTime() + 60_000), kind, row.timeZone)
      : new Date(now.getTime() + HOUR);
    await retryLater(row, later);
    return "retry_later";
  }
  if (result.reason === "promo_texts_disabled") {
    const next = row.step + 1;
    await setNext(row.id, next, next >= DRIP_STEPS.length ? null : dueTime(next, row.day1 || localYmd(now, row.timeZone), row.lastSentAt || now, row.timeZone));
    return "skipped_promo";
  }
  // opted out, no consent, not on the pilot list, Twilio refused…: stop.
  await stopDrip(phone, `send blocked: ${result.reason}`, "system", now);
  return "stopped";
}

// The welcome goes out right after Zapier gets its answer (tests run it inline).
type Schedule = (task: () => Promise<void>) => void;
let schedule: Schedule = (task) => after(task);
export function setDripScheduleForTests(fn: Schedule | null) {
  schedule = fn ?? ((task) => after(task));
}

/** Send the welcome (step 1) for a lead that just came in, after the response. */
export function scheduleWelcome(phone: string) {
  try {
    schedule(async () => {
      try {
        await processDrip(phone);
      } catch (error) {
        console.error("Welcome text failed:", error instanceof Error ? error.message : error);
      }
    });
  } catch (error) {
    console.error("Welcome text could not be scheduled:", error instanceof Error ? error.message : error);
  }
}

/** The timer: every lead whose next drip text is due. Stops early to stay inside the time budget. */
export async function runDueDrips(options: { now?: Date; limit?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const now = options.now || smsNow();
  const summary: Record<string, number> = {};
  if (!dripEnabled()) return { ran: 0, summary: { drip_off: 1 } };
  const sql = await smsDb();
  const due = await sql`SELECT phone FROM sms_conversations WHERE drip_status = 'active' AND drip_next_at <= ${now.toISOString()}::timestamptz
    ORDER BY drip_next_at LIMIT ${Math.min(options.limit ?? 40, 200)}`;
  let ran = 0;
  for (const r of due) {
    if (Date.now() - started > (options.budgetMs ?? 45_000)) break;
    try {
      const outcome = await processDrip(String(r.phone), options.now || smsNow());
      summary[outcome] = (summary[outcome] || 0) + 1;
    } catch (error) {
      summary.error = (summary.error || 0) + 1;
      console.error("Drip step failed:", error instanceof Error ? error.message : error);
    }
    ran++;
  }
  return { ran, due: due.length, summary };
}

/** Plain words for the inbox: "Step 3 of 16 · next Tue, Nov 4, 10:00 AM their time". */
export function dripLabel(d: { status: string | null; step: number | null; nextAt: string | null; stopReason: string | null }, timeZone: string): string {
  if (!d.status) return "";
  const total = DRIP_STEPS.length;
  if (d.status === "done") return `Drip finished (all ${total} texts)`;
  if (d.status === "stopped") return `Drip stopped: ${d.stopReason || "stopped"}`;
  if (d.status === "off") return `No drip: ${d.stopReason || "drip was off"}`;
  const step = (d.step ?? 0) + 1;
  const when = d.nextAt
    ? new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(d.nextAt))
    : "soon";
  return `Drip: text ${Math.min(step, total)} of ${total} next, ${when} their time`;
}
