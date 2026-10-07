/**
 * lib/fieldVoiceTools.ts
 *
 * The small set of ServiceTitan lookups that "Talk with Coach Denny" (voice,
 * for installers, sales reps and owners) can run while it is talking.
 *
 * Design rules:
 * - Who "me" is comes from the LOGIN (Team page row), never from what the
 *   person says. "This is Mike" does not change whose schedule is read.
 *   Only owners may ask about another technician by name.
 * - Read-only, with ONE exception: add_job_note. Reads go through the
 *   read-only allow-list (lib/mcpToolPolicy.ts); the note goes through the
 *   separate write path in lib/mcpJson.ts, only after Denny reads the note
 *   back and the person says yes (a signed confirmation code proves the
 *   preview happened). Installers and sales reps may only add notes to jobs
 *   on their own ServiceTitan schedule; owners may add to any job.
 * - Results are trimmed so the voice model gets what it needs to answer out
 *   loud without huge payloads.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DennyAccess } from "@/lib/access";
import { callMcpJson, callMcpWriteJson, McpToolError, type McpClient } from "@/lib/mcpJson";
import { claimNoteConfirmation } from "@/lib/teamStore";

// ---------------------------------------------------------------------------
// Tool definitions handed to the OpenAI realtime (voice) session
// ---------------------------------------------------------------------------

export const FIELD_VOICE_TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "get_my_schedule",
    description:
      "Get the signed-in person's own ServiceTitan schedule (customer appointments and blocked time) for a day or a few days. Use for questions like 'what does my schedule look like tomorrow' or 'what do I have Friday'.",
    parameters: {
      type: "object",
      properties: {
        day: {
          type: "string",
          description: "'today', 'tomorrow', or a date as YYYY-MM-DD. Defaults to today.",
        },
        days: {
          type: "integer",
          minimum: 1,
          maximum: 7,
          description: "How many days to include starting at 'day'. Default 1.",
        },
        technician_name: {
          type: "string",
          description: "OWNERS ONLY: another technician's name. Leave empty for the signed-in person.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_next_customer",
    description:
      "Find the signed-in person's next upcoming customer appointment and return a full customer 360 for it (contacts, jobs, notes, appointments, estimates, invoices, recent calls). Use for 'give me a 360 of my next customer'.",
    parameters: {
      type: "object",
      properties: {
        technician_name: {
          type: "string",
          description: "OWNERS ONLY: another technician's name. Leave empty for the signed-in person.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "get_customer_360",
    description:
      "Look up a customer in ServiceTitan by address, name, phone or customer ID and return a full customer 360. Use for 'what is the 360 of 123 Main Street'. Give the address exactly as spoken, including the street number.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "Street address or partial address, e.g. '7953 Kyle Ct'." },
        customer_name: { type: "string", description: "Customer name." },
        phone: { type: "string", description: "Customer phone number." },
        customer_id: { type: "integer", description: "ServiceTitan customer ID, when already known (for example from a list of matches)." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "find_sales_appointment_options",
    description:
      "Find the next available in-home sales consultation options for a prospective customer's ZIP code or address, using Den Defenders territory and routing rules. Read-only: it never books anything. Use for 'when can a sales rep come out to 95610'.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "ZIP code (preferred) or full address." },
        earliest_start_time: { type: "string", description: "Customer's earliest start, 24-hour HH:mm, if they said one." },
        latest_start_time: { type: "string", description: "Customer's latest start, 24-hour HH:mm, if they said one." },
        weekdays: {
          type: "array",
          items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
          description: "Only these weekdays, if the customer asked.",
        },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "add_job_note",
    description:
      "Add a note to a ServiceTitan job: the job the person is at right now, a job number, or the job at an address they say. TWO STEPS: first call with confirmed=false to get a preview (nothing is written), read the customer, job and exact note back, and ask 'Should I add it?'. Only after a clear yes, call again with confirmed=true and the confirmation_code from the preview. If they change the wording, start over with confirmed=false.",
    parameters: {
      type: "object",
      properties: {
        note_text: { type: "string", description: "The note, cleaned up into clear sentences but keeping every fact they said." },
        address: { type: "string", description: "Street address of the job, if they said one." },
        job_number: { type: "string", description: "ServiceTitan job number, if they said one." },
        confirmed: { type: "boolean", description: "false = preview only. true = write it (only after they said yes)." },
        confirmation_code: { type: "string", description: "The confirmation_code returned by the preview. Required when confirmed=true." },
      },
      required: ["note_text", "confirmed"],
      additionalProperties: false,
    },
  },
] as const;

export type FieldVoiceToolName = (typeof FIELD_VOICE_TOOL_DEFINITIONS)[number]["name"];

export function isFieldVoiceToolName(name: unknown): name is FieldVoiceToolName {
  return typeof name === "string" && FIELD_VOICE_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------
// Date / time helpers (ServiceTitan returns UTC timestamps)
// ---------------------------------------------------------------------------

function localDate(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(typeof iso === "string" ? new Date(iso) : iso);
}

function localTime(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

function localDayLabel(isoDate: string): string {
  // isoDate is YYYY-MM-DD; format it as a calendar day without time-zone drift.
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function todayFor(timeZone: string): string {
  return localDate(new Date(), timeZone);
}

function resolveDay(day: unknown, timeZone: string): string | null {
  const today = todayFor(timeZone);
  if (day === undefined || day === null || day === "") return today;
  const text = String(day).trim().toLowerCase();
  if (text === "today") return today;
  if (text === "tomorrow") return addDays(today, 1);
  if (text === "yesterday") return addDays(today, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

// ---------------------------------------------------------------------------
// Text compaction
// ---------------------------------------------------------------------------

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/=+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = stripHtml(value);
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const DROP_KEYS = new Set([
  "latitude", "longitude", "allContacts", "preferences", "createdById", "modifiedOn", "pagesRead",
  "apiTotalCount", "resultsMayBeTruncated", "filters", "zoneId", "zoneIds", "diagnostics",
]);

/** Generic shrink for payloads whose exact shape we do not depend on. */
function compact(value: unknown, depth = 0, stringMax = 300, arrayMax = 8): unknown {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string") return shortText(value, stringMax) ?? undefined;
  if (typeof value !== "object") return value;
  if (depth > 5) return undefined;
  if (Array.isArray(value)) {
    const items = value.slice(0, arrayMax).map((item) => compact(item, depth + 1, stringMax, arrayMax)).filter((item) => item !== undefined);
    if (value.length > arrayMax) items.push(`…and ${value.length - arrayMax} more`);
    return items.length ? items : undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(key)) continue;
    const next = compact(child, depth + 1, stringMax, arrayMax);
    if (next !== undefined) out[key] = next;
  }
  return Object.keys(out).length ? out : undefined;
}

const JOB_TYPE_NAMES: Record<number, string> = {
  2054262: "Install (Returning to Install)",
  2067446: "Sales consultation",
  85378173: "Phone consultation",
};

function jobTypeName(id: unknown): string | null {
  const num = Number(id);
  return Number.isFinite(num) && JOB_TYPE_NAMES[num] ? JOB_TYPE_NAMES[num] : null;
}

// ---------------------------------------------------------------------------
// ServiceTitan result shapes we rely on (only the fields we read)
// ---------------------------------------------------------------------------

type DispatchEvent = {
  eventType: "Job" | "NonJob";
  start?: string | null;
  end?: string | null;
  duration?: string | null;
  allDay?: boolean;
  name?: string | null;
  arrivalWindowStart?: string | null;
  arrivalWindowEnd?: string | null;
  appointmentStatus?: string | null;
  isConfirmed?: boolean;
  specialInstructions?: string | null;
  jobId?: number;
  jobNumber?: string;
  jobStatus?: string;
  jobTypeId?: number;
  customerId?: number;
  projectId?: number | null;
  jobSummary?: string | null;
  location?: { locationName?: string | null; address?: string | null } | null;
};

type DispatchBoard = { technicians?: { technicianId: number; technicianName: string; events?: DispatchEvent[] }[] };

type CustomerSearch = {
  resultCount?: number;
  customers?: {
    customerId: number;
    customerName: string;
    billingAddress?: string | null;
    matches?: { serviceAddress?: string | null; locationName?: string | null }[];
  }[];
};

type CustomerJob = {
  jobId: number;
  jobNumber?: string;
  status?: string;
  jobTypeId?: number;
  projectId?: number | null;
  createdOn?: string;
  completedOn?: string | null;
  total?: number;
  summary?: string | null;
};

type Contacts = {
  phones?: { number: string; memo?: string | null }[];
  mobilePhones?: { number: string; memo?: string | null; doNotText?: boolean }[];
  emails?: { email: string; memo?: string | null }[];
};

// ---------------------------------------------------------------------------
// Context + technician resolution
// ---------------------------------------------------------------------------

export type FieldVoiceContext = {
  access: DennyAccess;
  client: McpClient;
  timeZone: string;
};

type TechnicianTarget = { technicianId: number; name: string } | { error: string; choices?: string[] };

async function resolveTechnician(ctx: FieldVoiceContext, requestedName: unknown): Promise<TechnicianTarget> {
  const { access } = ctx;
  const ownTech = access.member?.stTechnicianId
    ? { technicianId: access.member.stTechnicianId, name: access.member.stTechnicianName || access.displayName }
    : null;
  const name = typeof requestedName === "string" ? requestedName.trim() : "";

  if (name && access.role === "owner") {
    const roster = await callMcpJson<{ technicians?: { technicianId: number; name: string; active: boolean }[] }>(
      ctx.client, "get_technician_roster", { name }
    );
    const matches = (roster.technicians || []).filter((tech) => tech.active);
    if (matches.length === 1) return { technicianId: matches[0].technicianId, name: matches[0].name };
    if (matches.length === 0) return { error: `No active technician matches "${name}".` };
    return { error: `More than one technician matches "${name}". Ask which one.`, choices: matches.map((tech) => tech.name) };
  }

  if (ownTech) return ownTech;
  return {
    error: access.role === "owner"
      ? "Your login isn't linked to a ServiceTitan technician. Ask whose schedule you want (owners can name a technician)."
      : "This login isn't linked to a ServiceTitan technician yet. An owner needs to link it on the Team page.",
  };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function describeEvent(event: DispatchEvent, timeZone: string) {
  const day = event.start ? localDate(event.start, timeZone) : null;
  if (event.eventType === "NonJob") {
    return {
      kind: "Blocked time",
      day: day ? localDayLabel(day) : null,
      start: event.allDay ? "All day" : localTime(event.start, timeZone),
      duration: event.duration || null,
      name: shortText(event.name, 80),
    };
  }
  return {
    kind: jobTypeName(event.jobTypeId) || "Customer appointment",
    day: day ? localDayLabel(day) : null,
    start: localTime(event.start, timeZone),
    end: localTime(event.end, timeZone),
    arrivalWindow: event.arrivalWindowStart
      ? `${localTime(event.arrivalWindowStart, timeZone)} to ${localTime(event.arrivalWindowEnd, timeZone)}`
      : null,
    customer: event.location?.locationName || null,
    address: event.location?.address || null,
    appointmentStatus: event.appointmentStatus || null,
    confirmed: event.isConfirmed ?? null,
    specialInstructions: shortText(event.specialInstructions, 300),
    jobNumber: event.jobNumber || null,
    jobId: event.jobId ?? null,
    customerId: event.customerId ?? null,
    jobSummary: shortText(event.jobSummary, 700),
  };
}

async function loadEvents(ctx: FieldVoiceContext, technicianId: number, firstDay: string, lastDay: string) {
  // Ask ServiceTitan for one extra UTC day on each side, then keep only events
  // whose LOCAL start date is inside the requested range.
  const board = await callMcpJson<DispatchBoard>(ctx.client, "get_dispatch_board", {
    startDate: addDays(firstDay, -1),
    endDate: addDays(lastDay, 1),
    technicianId,
    includeUnassigned: false,
    includeCanceled: false,
    includeNonJobAppointments: true,
  });
  const events = (board.technicians || []).flatMap((tech) => tech.events || []);
  return events
    .filter((event) => event.start)
    .filter((event) => {
      const day = localDate(event.start as string, ctx.timeZone);
      return day >= firstDay && day <= lastDay;
    })
    .sort((a, b) => Date.parse(a.start as string) - Date.parse(b.start as string));
}

async function getMySchedule(ctx: FieldVoiceContext, args: Record<string, unknown>) {
  const tech = await resolveTechnician(ctx, args.technician_name);
  if ("error" in tech) return tech;

  const firstDay = resolveDay(args.day, ctx.timeZone);
  if (!firstDay) return { error: "I need the day as today, tomorrow, or a date like 2026-10-09." };
  const days = Math.min(Math.max(Number(args.days) || 1, 1), 7);
  const lastDay = addDays(firstDay, days - 1);

  const events = await loadEvents(ctx, tech.technicianId, firstDay, lastDay);
  const customerCount = events.filter((event) => event.eventType === "Job").length;

  return {
    technician: tech.name,
    timeZone: ctx.timeZone,
    from: localDayLabel(firstDay),
    to: localDayLabel(lastDay),
    customerAppointmentCount: customerCount,
    events: events.map((event) => describeEvent(event, ctx.timeZone)),
    note: events.length === 0 ? "Nothing is on the ServiceTitan schedule for this range." : undefined,
  };
}

// ---------------------------------------------------------------------------
// Customer 360
// ---------------------------------------------------------------------------

const MAX_360_CHARACTERS = 14_000;

function isOpenJob(job: CustomerJob) {
  return !["Completed", "Canceled"].includes(String(job.status));
}

function settle<T>(promise: Promise<T>, label: string): Promise<T | { unavailable: string }> {
  return promise.catch((error: unknown) => {
    console.error(`360 piece failed (${label}):`, error instanceof Error ? error.message : error);
    return { unavailable: `${label} could not be loaded` };
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

async function buildCustomer360(ctx: FieldVoiceContext, customerId: number, focusJobId?: number | null) {
  const [search, contacts, jobsResult] = await Promise.all([
    settle(callMcpJson<CustomerSearch>(ctx.client, "search_customers", { query: String(customerId), searchType: "customerId" }), "customer"),
    settle(callMcpJson<Contacts>(ctx.client, "get_customer_contacts", { customerId }), "contacts"),
    settle(callMcpJson<{ totalJobs?: number; jobs?: CustomerJob[] }>(ctx.client, "get_customer_jobs", { customerId, pageSize: 50 }), "jobs"),
  ]);

  const customer = "customers" in search ? search.customers?.[0] : undefined;
  const allJobs = ("jobs" in jobsResult ? jobsResult.jobs || [] : [])
    .slice()
    .sort((a, b) => Date.parse(b.createdOn || "") - Date.parse(a.createdOn || ""));

  // Pick up to 4 jobs to open in detail: the focus job and its project
  // siblings first (sales job holds the estimate, install job holds the
  // appointment), then other open jobs, then the most recent ones.
  const picked: CustomerJob[] = [];
  const add = (job: CustomerJob | undefined) => {
    if (job && picked.length < 4 && !picked.some((p) => p.jobId === job.jobId)) picked.push(job);
  };
  const focus = allJobs.find((job) => job.jobId === focusJobId);
  add(focus);
  if (focus?.projectId) allJobs.filter((job) => job.projectId === focus.projectId).forEach(add);
  allJobs.filter(isOpenJob).forEach(add);
  allJobs.forEach(add);

  const jobDetails = await Promise.all(picked.map(async (job) => {
    const [notes, appointments, estimates, invoices] = await Promise.all([
      settle(callMcpJson(ctx.client, "get_job_notes", { jobId: job.jobId, maxPages: 1 }), "notes"),
      settle(callMcpJson(ctx.client, "get_job_appointments", { jobId: job.jobId, maxPages: 2 }), "appointments"),
      settle(callMcpJson(ctx.client, "get_job_estimates", { jobId: job.jobId, maxPages: 2 }), "estimates"),
      settle(callMcpJson(ctx.client, "get_job_invoices", { jobId: job.jobId, maxPages: 2 }), "invoices"),
    ]);
    return {
      jobId: job.jobId,
      jobNumber: job.jobNumber,
      type: jobTypeName(job.jobTypeId) || `Job type ${job.jobTypeId}`,
      status: job.status,
      created: job.createdOn ? localDayLabel(localDate(job.createdOn, ctx.timeZone)) : null,
      completed: job.completedOn ? localDayLabel(localDate(job.completedOn, ctx.timeZone)) : null,
      total: job.total,
      summary: shortText(job.summary, 600),
      notes: compact(notes, 0, 400, 6),
      appointments: compact(appointments, 0, 200, 4),
      estimates: compact(estimates, 0, 200, 6),
      invoices: compact(invoices, 0, 200, 4),
    };
  }));

  const contactInfo = "unavailable" in contacts ? contacts : {
    phones: [...(contacts.mobilePhones || []), ...(contacts.phones || [])].map((phone) => ({
      number: phone.number,
      memo: phone.memo || undefined,
      doNotText: "doNotText" in phone ? phone.doNotText : undefined,
    })),
    emails: (contacts.emails || []).map((email) => email.email),
  };

  // Recent calls from the call-recording cache only (no new transcriptions,
  // so the voice answer stays fast and costs nothing extra).
  const phone = "unavailable" in contacts
    ? null
    : contacts.mobilePhones?.[0]?.number || contacts.phones?.[0]?.number || null;
  const calls = phone
    ? await settle(withTimeout(callMcpJson(ctx.client, "get_servicetitan_customer_call_360", {
        phone,
        customerId,
        maxCalls: 5,
        maxNewTranscriptions: 0,
        maxTranscriptCharactersPerCall: 1200,
      }, 25_000), 25_000, "recent calls"), "recent calls")
    : { unavailable: "no phone number on file" };

  const result = {
    customerId,
    customerName: customer?.customerName || null,
    address: customer?.matches?.find((match) => match.serviceAddress)?.serviceAddress || customer?.billingAddress || null,
    contacts: contactInfo,
    totalJobs: "totalJobs" in jobsResult ? jobsResult.totalJobs : allJobs.length,
    otherJobs: allJobs.filter((job) => !picked.some((p) => p.jobId === job.jobId)).slice(0, 8).map((job) => ({
      jobNumber: job.jobNumber,
      type: jobTypeName(job.jobTypeId) || `Job type ${job.jobTypeId}`,
      status: job.status,
      created: job.createdOn ? localDate(job.createdOn, ctx.timeZone) : null,
    })),
    jobsInDetail: jobDetails,
    recentCalls: compact(calls, 0, 400, 5),
  };

  // Keep the voice payload bounded: shrink the bulkiest parts if needed.
  let text = JSON.stringify(result);
  if (text.length > MAX_360_CHARACTERS) {
    result.recentCalls = compact(calls, 0, 150, 3);
    for (const job of result.jobsInDetail) {
      job.notes = compact(job.notes, 0, 200, 4);
      job.estimates = compact(job.estimates, 0, 100, 3);
      job.invoices = compact(job.invoices, 0, 100, 2);
      job.appointments = compact(job.appointments, 0, 100, 2);
    }
    text = JSON.stringify(result);
  }
  if (text.length > MAX_360_CHARACTERS) {
    return { ...result, jobsInDetail: result.jobsInDetail.slice(0, 2), note: "Some older detail was left out to keep this short." };
  }
  return result;
}

async function getCustomer360(ctx: FieldVoiceContext, args: Record<string, unknown>) {
  const customerId = Number(args.customer_id);
  if (Number.isSafeInteger(customerId) && customerId > 0) return buildCustomer360(ctx, customerId);

  const address = typeof args.address === "string" ? args.address.trim() : "";
  const name = typeof args.customer_name === "string" ? args.customer_name.trim() : "";
  const phone = typeof args.phone === "string" ? args.phone.trim() : "";
  const query = address || phone || name;
  if (query.length < 2) return { error: "I need an address, a customer name, or a phone number." };
  const searchType = address ? "address" : phone ? "phone" : "name";

  const search = await callMcpJson<CustomerSearch>(ctx.client, "search_customers", { query, searchType });
  const customers = search.customers || [];
  if (customers.length === 0) return { error: `No ServiceTitan customer matched "${query}".` };
  if (customers.length > 1) {
    return {
      multipleMatches: customers.slice(0, 6).map((customer) => ({
        customerId: customer.customerId,
        customerName: customer.customerName,
        address: customer.matches?.find((match) => match.serviceAddress)?.serviceAddress || customer.billingAddress || null,
      })),
      instruction: "Read the matches briefly and ask which customer they mean, then call get_customer_360 again with that customer_id.",
    };
  }
  return buildCustomer360(ctx, customers[0].customerId);
}

async function getNextCustomer(ctx: FieldVoiceContext, args: Record<string, unknown>) {
  const tech = await resolveTechnician(ctx, args.technician_name);
  if ("error" in tech) return tech;

  const today = todayFor(ctx.timeZone);
  const events = await loadEvents(ctx, tech.technicianId, today, addDays(today, 14));
  const cutoff = Date.now() - 15 * 60 * 1000; // still count one that started a few minutes ago
  const next = events.find((event) => event.eventType === "Job" && Date.parse(event.start as string) >= cutoff);
  if (!next) return { technician: tech.name, note: "No upcoming customer appointments in the next two weeks." };

  const appointment = describeEvent(next, ctx.timeZone);
  if (!next.customerId) return { technician: tech.name, nextAppointment: appointment };

  return {
    technician: tech.name,
    nextAppointment: appointment,
    customer360: await buildCustomer360(ctx, next.customerId, next.jobId),
  };
}

// ---------------------------------------------------------------------------
// Sales availability (read-only recommendation)
// ---------------------------------------------------------------------------

type SalesOption = {
  date: string;
  dayOfWeek: string;
  consultantName: string;
  consultantTimeZone?: string;
  appointmentDurationMinutes?: number;
  localStart?: string;
  localEnd?: string;
};

async function findSalesOptions(ctx: FieldVoiceContext, args: Record<string, unknown>) {
  const location = typeof args.location === "string" ? args.location.trim() : "";
  if (location.length < 2) return { error: "I need a ZIP code or address." };

  const request: Record<string, unknown> = { appointmentLocation: location, maxRecommendations: 3 };
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof args.earliest_start_time === "string" && timePattern.test(args.earliest_start_time)) request.earliestStartTime = args.earliest_start_time;
  if (typeof args.latest_start_time === "string" && timePattern.test(args.latest_start_time)) request.latestStartTime = args.latest_start_time;
  if (Array.isArray(args.weekdays) && args.weekdays.length) request.requestedWeekdays = args.weekdays;

  const result = await callMcpJson<{ recommendationStatus?: string; options?: SalesOption[]; finalInstruction?: string }>(
    ctx.client, "recommend_sales_schedule", request, 180_000
  );

  const toTime = (value?: string) => {
    const hhmm = value?.split(" ")[1];
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };

  return {
    status: result.recommendationStatus || null,
    options: (result.options || []).map((option) => ({
      day: `${option.dayOfWeek} ${localDayLabel(option.date).split(", ").slice(1).join(", ")}`.trim(),
      date: option.date,
      salesRep: option.consultantName,
      start: toTime(option.localStart),
      end: toTime(option.localEnd),
      repTimeZone: option.consultantTimeZone || null,
      minutes: option.appointmentDurationMinutes ?? null,
    })),
    reminder: "Recommendations only. Nothing is booked. The office must confirm and book in ServiceTitan.",
  };
}

// ---------------------------------------------------------------------------
// Add a job note (the only write)
// ---------------------------------------------------------------------------

const NOTE_CONFIRM_MS = 5 * 60 * 1000;
const NOTE_MAX = 3000;

function noteSecret(): string {
  const secret = process.env.AUTH0_SECRET || process.env.FIELD_VOICE_NOTE_SECRET;
  if (!secret) throw new Error("AUTH0_SECRET is not set; cannot sign note confirmations.");
  return `${secret}:field-voice-job-note`;
}

function signNote(email: string, jobId: number, text: string, expiresAt: number, nonce: string): string {
  const mac = createHmac("sha256", noteSecret())
    .update(`${email}\n${jobId}\n${text}\n${expiresAt}\n${nonce}`)
    .digest("base64url");
  return `${expiresAt}.${nonce}.${mac}`;
}

/** Returns the code's single-use nonce when it is valid for exactly this note, else null. */
function verifyNoteCode(code: unknown, email: string, jobId: number, text: string): string | null {
  if (typeof code !== "string") return null;
  const [expiresRaw, nonce] = code.split(".");
  const expiresAt = Number(expiresRaw);
  if (!nonce || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const expected = Buffer.from(signNote(email, jobId, text, expiresAt, nonce));
  const given = Buffer.from(code);
  return expected.length === given.length && timingSafeEqual(expected, given) ? nonce : null;
}

type NoteTarget = { jobId: number; customer: string | null; address: string | null; when: string | null; spokenJobNumber?: string };
type NoteTargetResult = { target: NoteTarget } | { error: string } | { choices: unknown[]; instruction: string };

/**
 * Jobs on this technician's schedule: today only for "the job I'm at",
 * otherwise two weeks back to two weeks ahead.
 */
async function scheduledJobs(ctx: FieldVoiceContext, technicianId: number, todayOnly: boolean) {
  const today = todayFor(ctx.timeZone);
  const events = todayOnly
    ? await loadEvents(ctx, technicianId, today, today)
    : await loadEvents(ctx, technicianId, addDays(today, -14), addDays(today, 14));
  return events.filter((event) => event.eventType === "Job" && event.jobId);
}

function targetFromEvent(event: DispatchEvent, timeZone: string): NoteTarget {
  const day = event.start ? localDayLabel(localDate(event.start, timeZone)) : null;
  return {
    jobId: event.jobId as number,
    customer: event.location?.locationName || null,
    address: event.location?.address || null,
    when: day ? `${day} ${localTime(event.start, timeZone) || ""}`.trim() : null,
  };
}

function normalizeAddress(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

async function resolveNoteTarget(ctx: FieldVoiceContext, args: Record<string, unknown>): Promise<NoteTargetResult> {
  const isOwner = ctx.access.role === "owner";
  const address = typeof args.address === "string" ? args.address.trim() : "";
  const jobNumber = typeof args.job_number === "string" || typeof args.job_number === "number"
    ? String(args.job_number).replace(/[^0-9]/g, "")
    : "";
  const techId = ctx.access.member?.stTechnicianId ?? null;

  if (!isOwner && !techId) {
    return { error: "This login isn't linked to a ServiceTitan technician yet, so I can't tell which jobs are yours. An owner can link it on the Team page." };
  }
  const mine = techId ? await scheduledJobs(ctx, techId, !jobNumber && !address) : [];

  // 1. A job number they said.
  if (jobNumber) {
    const id = Number(jobNumber);
    const onSchedule = mine.find((event) => event.jobId === id || event.jobNumber === jobNumber);
    if (onSchedule) return { target: targetFromEvent(onSchedule, ctx.timeZone) };
    // Owners: any job. The preview step checks ServiceTitan's job number
    // matches what was said before a confirmation code is issued.
    if (isOwner) return { target: { jobId: id, customer: null, address: null, when: null, spokenJobNumber: jobNumber } };
    return { error: `Job ${jobNumber} isn't on your schedule for the last or next two weeks, so I can't add a note to it. The office can add it.` };
  }

  // 2. An address they said.
  if (address) {
    const wanted = normalizeAddress(address);
    const streetNumber = wanted.split(" ")[0];
    const onSchedule = mine.filter((event) => {
      const candidate = normalizeAddress(event.location?.address || "");
      return candidate.includes(wanted) || (streetNumber && candidate.startsWith(`${streetNumber} `) && wanted.split(" ").slice(1, 2).every((word) => candidate.includes(word)));
    });
    const uniqueJobs = [...new Map(onSchedule.map((event) => [event.jobId, event])).values()];
    if (uniqueJobs.length === 1) return { target: targetFromEvent(uniqueJobs[0], ctx.timeZone) };
    if (uniqueJobs.length > 1) {
      return {
        choices: uniqueJobs.slice(0, 5).map((event) => ({ jobNumber: event.jobNumber, ...targetFromEvent(event, ctx.timeZone), kind: jobTypeName(event.jobTypeId) })),
        instruction: "More than one of their jobs is at that address. Ask which one, then call add_job_note again with job_number.",
      };
    }
    if (!isOwner) {
      return { error: `I don't see a job at "${address}" on your schedule for the last or next two weeks. Check the address, or the office can add the note.` };
    }
    // Owners: find the customer's most recent open job.
    const search = await callMcpJson<CustomerSearch>(ctx.client, "search_customers", { query: address, searchType: "address" });
    const customers = search.customers || [];
    if (customers.length !== 1) {
      return customers.length === 0
        ? { error: `No ServiceTitan customer matched "${address}".` }
        : { choices: customers.slice(0, 5).map((c) => ({ customerId: c.customerId, customerName: c.customerName, address: c.billingAddress })), instruction: "Several customers match. Ask for the job number instead." };
    }
    const jobs = await callMcpJson<{ jobs?: CustomerJob[] }>(ctx.client, "get_customer_jobs", { customerId: customers[0].customerId, pageSize: 50 });
    const open = (jobs.jobs || []).filter(isOpenJob).sort((a, b) => Date.parse(b.createdOn || "") - Date.parse(a.createdOn || ""));
    if (open.length === 1) {
      return { target: { jobId: open[0].jobId, customer: customers[0].customerName, address: customers[0].billingAddress || null, when: null } };
    }
    return open.length === 0
      ? { error: "That customer has no open job. Ask for a job number." }
      : { choices: open.slice(0, 5).map((job) => ({ jobNumber: job.jobNumber, type: jobTypeName(job.jobTypeId), status: job.status })), instruction: "Several open jobs. Ask which one, then call again with job_number." };
  }

  // 3. "The job I'm at": the appointment happening now on their schedule.
  if (!techId) return { error: "Tell me the job number or address for the note." };
  const now = Date.now();
  const today = todayFor(ctx.timeZone);
  const todays = mine.filter((event) => localDate(event.start as string, ctx.timeZone) === today);
  const current = todays.filter((event) => {
    const start = Date.parse(event.start as string) - 60 * 60 * 1000;
    const end = Date.parse((event.end || event.start) as string) + 60 * 60 * 1000;
    return now >= start && now <= end;
  });
  const pick = current.length === 1 ? current : todays.length === 1 ? todays : [];
  if (pick.length === 1) return { target: targetFromEvent(pick[0], ctx.timeZone) };
  if (todays.length === 0) return { error: "You don't have a customer job on today's schedule. Tell me the address or job number." };
  return {
    choices: todays.map((event) => ({ jobNumber: event.jobNumber, ...targetFromEvent(event, ctx.timeZone) })),
    instruction: "Ask which of today's jobs the note is for (by customer or address), then call again with job_number.",
  };
}

async function addJobNote(ctx: FieldVoiceContext, args: Record<string, unknown>) {
  const spoken = typeof args.note_text === "string" ? args.note_text.trim() : "";
  if (!spoken) return { error: "What should the note say?" };
  if (spoken.length > NOTE_MAX) return { error: `That note is too long. Keep it under ${NOTE_MAX} characters.` };
  const email = ctx.access.email;
  if (!email) return { error: "Your login has no email address, so I can't sign the note." };

  const resolved = await resolveNoteTarget(ctx, args);
  if (!("target" in resolved)) return resolved;
  const { target } = resolved;

  // What actually lands in ServiceTitan: their words plus who said it, because
  // ServiceTitan itself records the API app, not the person, as the author.
  const noteText = `${spoken}\n\n— ${ctx.access.displayName} (via Coach Denny voice)`;

  try {
    if (args.confirmed !== true) {
      const preview = await callMcpWriteJson<{ target?: { jobNumber?: string; customerName?: string | null; jobStatus?: string | null } }>(
        ctx.client, "add_job_note", { jobId: target.jobId, text: noteText, dryRun: true }
      );
      if (target.spokenJobNumber && preview.target?.jobNumber && preview.target.jobNumber !== target.spokenJobNumber) {
        return { error: `I couldn't match job number ${target.spokenJobNumber} exactly in ServiceTitan. Give me the address instead.` };
      }
      const expiresAt = Date.now() + NOTE_CONFIRM_MS;
      return {
        preview: true,
        nothingWrittenYet: true,
        jobNumber: preview.target?.jobNumber || String(target.jobId),
        customer: preview.target?.customerName || target.customer,
        address: target.address,
        appointment: target.when,
        noteWillRead: spoken,
        signedAs: ctx.access.displayName,
        confirmation_code: signNote(email, target.jobId, noteText, expiresAt, randomBytes(12).toString("base64url")),
        instruction: "Read back the customer, address and note, ask 'Should I add it?', and only after a clear yes call add_job_note again with the same note_text, the same job_number/address, confirmed=true and this confirmation_code.",
      };
    }

    const nonce = verifyNoteCode(args.confirmation_code, email, target.jobId, noteText);
    if (!nonce) {
      return { error: "That confirmation expired or the note changed. Run the preview again (confirmed=false) and read it back first." };
    }
    if (!await claimNoteConfirmation(nonce, email, target.jobId)) {
      return { error: "That note was already sent once, so I didn't send it again." };
    }

    const written = await callMcpWriteJson<{ executed?: boolean; verified?: boolean; target?: { jobNumber?: string; customerName?: string | null } }>(
      ctx.client, "add_job_note", { jobId: target.jobId, text: noteText, dryRun: false, confirm: true }
    );
    console.info(`Field voice note written by ${email} on job ${target.jobId} (verified=${written.verified === true})`);
    return {
      written: written.executed === true,
      verified: written.verified === true,
      jobNumber: written.target?.jobNumber || String(target.jobId),
      customer: written.target?.customerName || target.customer,
      message: written.verified === true
        ? "The note is on the job in ServiceTitan."
        : "ServiceTitan accepted the note but it did not show up right away. Do not add it again; check the job in a minute.",
    };
  } catch (error) {
    if (error instanceof McpToolError) {
      if (error.message === "NOT_ALLOWED") {
        return { error: "Your login isn't set up to add notes yet. Ask an owner to give you the field_notes role in Auth0, then sign out and back in." };
      }
      if (error.message === "DUPLICATE_NOTE") return { error: "That exact note was already added to this job in the last ten minutes, so I didn't add it again." };
      if (error.message === "SERVICETITAN_WRITE_DISABLED") return { error: "Note writing is switched off on the server right now. Nothing was written." };
      if (error.message === "SERVICETITAN_WRITE_UNVERIFIED") return { error: "ServiceTitan accepted the note but it didn't show up right away. Don't add it again; check the job in a minute." };
      if (error.message === "JOB_NOT_FOUND") return { error: "ServiceTitan couldn't find that job. Nothing was written." };
      if (args.confirmed === true) {
        return { error: "I couldn't confirm whether the note saved. Please check the job in ServiceTitan before trying again, so it doesn't get added twice." };
      }
      return { error: "I couldn't reach ServiceTitan to prepare the note. Nothing was written. Try again in a minute." };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function runFieldVoiceTool(
  ctx: FieldVoiceContext,
  name: FieldVoiceToolName,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "get_my_schedule":
      return getMySchedule(ctx, args);
    case "get_next_customer":
      return getNextCustomer(ctx, args);
    case "get_customer_360":
      return getCustomer360(ctx, args);
    case "find_sales_appointment_options":
      return findSalesOptions(ctx, args);
    case "add_job_note":
      return addJobNote(ctx, args);
  }
}
