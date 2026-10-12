/**
 * app/api/website-bot/route.ts
 *
 * Public chat endpoint behind the dendefenders.com chat bubble.
 *
 *   - No login. proxy.ts lets this path through; everything else on Denny
 *     still requires Auth0.
 *   - Only accepts requests from the websites in WEBSITE_BOT_ALLOWED_ORIGINS.
 *   - Off unless WEBSITE_BOT_ENABLED=true (the kill switch).
 *   - Phase 1 tool: find_open_times -> recommend_sales_schedule, reduced to
 *     dates and arrival windows before the model sees it.
 *   - Phase 2 tool: prepare_booking -> live slot re-check + MCP dry run ->
 *     preview + signed ticket. Booking only happens on the separate
 *     {action:"confirm"} request the widget sends when the visitor clicks
 *     Confirm, and only when WEBSITE_BOT_BOOKING_ENABLED=true.
 *   - Text-message check (WEBSITE_BOT_SMS_VERIFY_ENABLED=true): before the
 *     confirm, the widget asks for {action:"send_code"} and
 *     {action:"check_code"}; Twilio Verify texts the phone number inside the
 *     signed ticket, and confirm then requires the signed proof.
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { WEBSITE_BOT_PHONE, WEBSITE_BOT_PRICE_RANGE, websiteBotSystemPrompt } from "@/app/lib/websiteBotPrompt";
import {
  allowBooking,
  allowCodeCheck,
  allowCodeSend,
  allowCustomerLookup,
  allowLookup,
  allowMessage,
  clientIp,
  corsHeaders,
  originAllowed,
  websiteBotEnabled,
} from "@/lib/websiteBotGuard";
import {
  addWebsiteChatNote,
  bookSalesAppointmentFromWebsite,
  findCustomerLocationAtAddress,
  findOpenSalesTimes,
  lookupReturningCustomer,
  resolveSlotForBooking,
  WebsiteBotConfigError,
} from "@/lib/websiteBotMcp";
import {
  bookingEnabled,
  normalizePhone,
  postBookingToSlack,
  previewFor,
  signBookingTicket,
  signCustomerRef,
  transcriptNote,
  validateBookingInput,
  verifyBookingTicket,
} from "@/lib/websiteBotBooking";
import {
  checkVerificationCode,
  sendVerificationCode,
  signVerifiedProof,
  smsConsent,
  smsVerifyEnabled,
  verifyVerifiedProof,
} from "@/lib/websiteBotSms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 1000;
const MODEL = process.env.WEBSITE_BOT_MODEL || "gpt-4o-mini";

type ChatMessage = { role: "user" | "assistant"; content: string };

function json(body: unknown, status: number, origin: string | null) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

function todayPacific(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

function cleanMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
    const role = item?.role === "assistant" ? "assistant" : item?.role === "user" ? "user" : null;
    const content = typeof item?.content === "string" ? item.content.trim().slice(0, MAX_MESSAGE_CHARS) : "";
    if (role && content) out.push({ role, content });
  }
  return out;
}

const FIND_OPEN_TIMES_TOOL = {
  type: "function" as const,
  function: {
    name: "find_open_times",
    description:
      "Look up open in-home consultation times near the visitor's ZIP code. Call only after the visitor has given a 5-digit ZIP. Returns dates with arrival windows.",
    parameters: {
      type: "object",
      properties: {
        zip: { type: "string", description: "Visitor's 5-digit ZIP code.", pattern: "^\\d{5}$" },
        earliestStartTime: { type: "string", description: "Optional earliest acceptable start, 24-hour HH:mm (e.g. 13:00 for 'afternoons')." },
        latestStartTime: { type: "string", description: "Optional latest acceptable start, 24-hour HH:mm (e.g. 11:00 for 'mornings')." },
        requestedWeekdays: {
          type: "array",
          items: { type: "string", enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] },
          description: "Optional weekdays the visitor asked for.",
        },
        requestedDates: {
          type: "array",
          items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          description: "Optional exact dates the visitor asked for (YYYY-MM-DD).",
        },
      },
      required: ["zip"],
    },
  },
};

const LOOKUP_CUSTOMER_TOOL = {
  type: "function" as const,
  function: {
    name: "lookup_returning_customer",
    description:
      "Check whether the visitor is an existing Den Defenders customer, using the mobile number or email THEY gave you. Call it as soon as someone says they have bought from us before, or gives a phone/email early in the chat. ALWAYS include lastName and zip too when you know them from the conversation; numbers are sometimes shared between records and those break the tie. Returns their first name, what we installed for them, and a customerRef to pass to prepare_booking. If the result is ambiguous, ask for their last name and call again. If not matched, treat them as new and do not mention the lookup.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "Mobile number the visitor typed." },
        email: { type: "string", description: "Email the visitor typed (use when no phone)." },
        lastName: { type: "string", description: "Visitor's last name if known; helps when a number is shared." },
        zip: { type: "string", description: "Visitor's ZIP if known; helps when a number is shared." },
      },
    },
  },
};

const PREPARE_BOOKING_TOOL = {
  type: "function" as const,
  function: {
    name: "prepare_booking",
    description:
      "Prepare the visitor's consultation booking for their confirmation. Call ONLY after the visitor has chosen one of the times from find_open_times AND you have every required field. Fill the qualifying answers (reason, priority, otherOptions, timeline, entryPoints, decisionMakers, heardAboutUs, priceRange, parking) from what the visitor already said in this conversation; ask only for the ones that were never covered. The server re-checks the time, builds a preview, and shows the visitor a Confirm button. Nothing is booked until they click it. If the result says MISSING, ask for the listed items one at a time and call again.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Chosen date from find_open_times (YYYY-MM-DD)." },
        arrivalWindow: { type: "string", description: "Chosen arrival window exactly as find_open_times returned it, e.g. '12 PM - 4 PM'." },
        customerRef: { type: "string", description: "The customerRef returned by lookup_returning_customer, when the visitor was matched. Books under their existing record." },
        fullName: { type: "string", description: "Visitor's first and last name." },
        phone: { type: "string", description: "Mobile phone number, 10 digits." },
        email: { type: "string", description: "Email address." },
        street: { type: "string", description: "Street address of the home, including house number." },
        unit: { type: "string", description: "Apartment or unit, if any." },
        city: { type: "string" },
        state: { type: "string", description: "Two-letter state, e.g. CA." },
        zip: { type: "string", pattern: "^\\d{5}$" },
        reason: { type: "string", description: "Q1: what had them looking into our products - a specific concern or just upgrading." },
        priority: { type: "string", description: "Q2: most important - security, appearance, or long-term value." },
        otherOptions: { type: "string", description: "Q3: looked at other options, or just starting." },
        timeline: { type: "string", description: "Q4: fairly soon, or gathering options." },
        entryPoints: { type: "string", description: "Q5: entry points - front, side, back, slider, window." },
        decisionMakers: { type: "string", description: "Q6: sole decision-maker, or reviewing with someone else (and that they will attend)." },
        heardAboutUs: { type: "string", description: "How they heard about Den Defenders." },
        priceRange: { type: "string", description: "The price range you quoted them, e.g. '$3,800-$5,300 per door'." },
        parking: { type: "string", description: "Gate code, parking or other access instructions. 'None' is fine." },
        notes: { type: "string", description: "Anything else useful for the design specialist (what they want to secure, colors mentioned, pets)." },
      },
      required: [
        "date", "arrivalWindow", "fullName", "phone", "email", "street", "city", "state", "zip",
        "reason", "priority", "otherOptions", "timeline", "entryPoints", "decisionMakers", "heardAboutUs", "priceRange", "parking",
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Confirm: the visitor clicked the button in the preview card
// ---------------------------------------------------------------------------

async function handleConfirm(body: Record<string, unknown>, origin: string | null, ip: string, testMode: boolean) {
  if (!bookingEnabled()) {
    return json({ error: "Online booking isn't turned on yet. Please give us a call to lock in your time." }, 503, origin);
  }
  const ticket = verifyBookingTicket(typeof body.token === "string" ? body.token : "");
  if (!ticket) {
    return json({ error: "That booking preview has expired. Ask Denny to prepare it again." }, 400, origin);
  }
  const token = body.token as string;
  if (smsVerifyEnabled()) {
    const proof = typeof body.proof === "string" ? body.proof : "";
    if (!verifyVerifiedProof(proof, token, ticket.customer.phone)) {
      return json({ booked: false, needCode: true, error: "Please confirm your mobile number with the text code first." }, 400, origin);
    }
  }
  if (!allowBooking(ticket.sessionId, ip)) {
    return json({ error: "A booking was already made from this chat. Please call us to make changes." }, 429, origin);
  }

  const result = await bookSalesAppointmentFromWebsite({
    slot: ticket.slot,
    customer: ticket.customer,
    qualifying: ticket.qualifying,
    customerNotes: ticket.customerNotes,
    dryRun: false,
    existing: ticket.existing,
  });

  if (!result.ok) {
    console.warn("Website bot booking refused:", result.code);
    // Never reveal why (e.g. that the customer already exists in ServiceTitan).
    return json(
      {
        booked: false,
        reply:
          "I wasn't able to finish the booking online, but your details are safe with us. Please call 800-992-9938 and mention the date and window you chose - the team can usually confirm it right away.",
      },
      200,
      origin
    );
  }

  const preview = previewFor(ticket);
  console.info(`Website bot booked job ${result.jobNumber || "?"} for ${preview.name} on ${preview.date} ${preview.arrivalWindow}`);

  // Save the chat on the job so the office and the rep can read what was said.
  const transcript = cleanMessages(body.messages);
  if (result.jobId && transcript.length) {
    await addWebsiteChatNote(result.jobId, transcriptNote(transcript, preview, testMode));
  }

  await postBookingToSlack(ticket, result.jobNumber, testMode);

  return json(
    {
      booked: true,
      reply: `You're all set, ${ticket.customer.name.split(" ")[0]}! Your custom design and security consultation is booked for ${preview.weekday}, ${preview.dateLabel}, arrival between ${preview.arrivalWindow}, at ${preview.address}. We'll send a confirmation to ${preview.email}. Please make sure everyone involved in the decision can be there. See you soon!`,
    },
    200,
    origin
  );
}

// ---------------------------------------------------------------------------
// Text-message code (Twilio Verify) for the preview card
// ---------------------------------------------------------------------------

const CALL_US = `Please give us a call at 800-992-9938 and the team will lock in your time.`;

async function handleSendCode(body: Record<string, unknown>, origin: string | null, ip: string) {
  if (!smsVerifyEnabled()) return json({ error: "Text verification is not turned on." }, 400, origin);
  const ticket = verifyBookingTicket(typeof body.token === "string" ? body.token : "");
  if (!ticket) return json({ error: "That booking preview has expired. Ask Denny to prepare it again." }, 400, origin);
  if (!allowCodeSend(ticket.sessionId, ip)) {
    return json({ error: `We've already sent a few codes. ${CALL_US}` }, 429, origin);
  }
  const sent = await sendVerificationCode(ticket.customer.phone);
  if (sent.ok) {
    return json({ sent: true, phoneLast4: ticket.customer.phone.slice(-4) }, 200, origin);
  }
  const messages: Record<string, string> = {
    INVALID_NUMBER: "We couldn't text that number. Please press Change and give us a mobile (cell) number that can receive texts.",
    TOO_MANY: `Too many codes were requested for that number. Please wait 10 minutes, or ${CALL_US.charAt(0).toLowerCase()}${CALL_US.slice(1)}`,
    BLOCKED: `We couldn't send a code to that number. ${CALL_US}`,
    NOT_CONFIGURED: `Online booking is having a hiccup. ${CALL_US}`,
    FAILED: `We couldn't send the text just now. Please try again in a minute, or ${CALL_US.charAt(0).toLowerCase()}${CALL_US.slice(1)}`,
  };
  if (sent.reason === "NOT_CONFIGURED") console.error("Website bot: SMS verify is on but Twilio settings are missing.");
  return json({ sent: false, error: messages[sent.reason] || messages.FAILED }, 200, origin);
}

async function handleCheckCode(body: Record<string, unknown>, origin: string | null, ip: string) {
  if (!smsVerifyEnabled()) return json({ error: "Text verification is not turned on." }, 400, origin);
  const token = typeof body.token === "string" ? body.token : "";
  const ticket = verifyBookingTicket(token);
  if (!ticket) return json({ error: "That booking preview has expired. Ask Denny to prepare it again." }, 400, origin);
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  if (!/^\d{4,10}$/.test(code)) return json({ verified: false, error: "Please enter the 6-digit code from the text." }, 200, origin);
  if (!allowCodeCheck(ticket.sessionId, ip)) return json({ verified: false, error: `Too many tries. ${CALL_US}` }, 429, origin);

  const checked = await checkVerificationCode(ticket.customer.phone, code);
  if (checked.ok) {
    return json({ verified: true, proof: signVerifiedProof(token, ticket.customer.phone) }, 200, origin);
  }
  const messages: Record<string, string> = {
    WRONG: "That code doesn't match. Please check the text and try again.",
    EXPIRED: "That code has expired or was tried too many times. Tap \"Text me a new code\" to get a fresh one.",
    NOT_CONFIGURED: `Online booking is having a hiccup. ${CALL_US}`,
    FAILED: "We couldn't check the code just now. Please try again in a moment.",
  };
  return json({ verified: false, error: messages[checked.reason] || messages.FAILED }, 200, origin);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const origin = req.headers.get("origin");

  if (!originAllowed(origin)) {
    return json({ error: "This chat can only be used from the Den Defenders website." }, 403, origin);
  }
  if (!websiteBotEnabled()) {
    return json({ error: "The chat assistant is offline right now. Please give us a call." }, 503, origin);
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = typeof body.sessionId === "string" && /^[a-z0-9]{8,64}$/i.test(body.sessionId) ? body.sessionId : "anon";
  const testMode = body.mode === "test";
  const ip = clientIp(req.headers);

  if (body.action === "send_code" || body.action === "check_code") {
    try {
      return body.action === "send_code"
        ? await handleSendCode(body, origin, ip)
        : await handleCheckCode(body, origin, ip);
    } catch (error) {
      console.error(`Website bot ${body.action} crashed:`, error instanceof Error ? error.message : error);
      return json({ error: "Sorry, something went wrong. Please give us a call at 800-992-9938." }, 500, origin);
    }
  }

  if (body.action === "confirm") {
    try {
      return await handleConfirm(body, origin, ip, testMode);
    } catch (error) {
      console.error("Website bot confirm crashed:", error instanceof Error ? error.message : error);
      return json({ error: "Sorry, something went wrong while booking. Please give us a call." }, 500, origin);
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Website bot: OPENAI_API_KEY missing");
    return json({ error: "The chat assistant is not set up yet." }, 500, origin);
  }

  const messages = cleanMessages(body.messages);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return json({ error: "Missing message." }, 400, origin);
  }
  if (!allowMessage(sessionId, ip)) {
    return json({ error: "You've sent a lot of messages. Please give us a call and we'll be glad to help." }, 429, origin);
  }

  const openai = new OpenAI({ apiKey });
  const canBook = bookingEnabled();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thread: any[] = [
    { role: "system", content: websiteBotSystemPrompt(todayPacific(), testMode, canBook) },
    ...messages,
  ];
  const tools = canBook
    ? [FIND_OPEN_TIMES_TOOL, LOOKUP_CUSTOMER_TOOL, PREPARE_BOOKING_TOOL]
    : [FIND_OPEN_TIMES_TOOL, LOOKUP_CUSTOMER_TOOL];

  // Set when prepare_booking succeeds; returned to the widget with the reply.
  let bookingCard: { token: string; preview: ReturnType<typeof previewFor>; sms?: ReturnType<typeof smsConsent> } | null = null;

  try {
    for (let round = 0; round < 5; round++) {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 450,
        messages: thread,
        tools,
        tool_choice: "auto",
      });

      const message = completion.choices?.[0]?.message;
      if (!message) return json({ error: "No reply. Please try again." }, 502, origin);
      thread.push(message);

      const toolCalls = message.tool_calls || [];
      if (!toolCalls.length) {
        const reply = plainText(message.content?.trim() || "Sorry, could you say that again?");
        return json(bookingCard ? { reply, booking: bookingCard } : { reply }, 200, origin);
      }

      for (const call of toolCalls) {
        if (call.type !== "function") continue;
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }

        const reply = (content: unknown) =>
          thread.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(content) });

        if (call.function.name === "find_open_times") {
          const zip = typeof args.zip === "string" ? args.zip.trim() : "";
          if (!/^\d{5}$/.test(zip)) { reply({ error: "NEED_ZIP", message: "Ask the visitor for a 5-digit ZIP code first." }); continue; }
          if (!allowLookup(sessionId)) { reply({ error: "LOOKUP_LIMIT", message: "Availability lookups are limited per chat. Offer the phone number." }); continue; }

          const startedAt = Date.now();
          try {
            const availability = await findOpenSalesTimes({
              location: zip,
              earliestStartTime: timeArg(args.earliestStartTime),
              latestStartTime: timeArg(args.latestStartTime),
              requestedWeekdays: stringArray(args.requestedWeekdays),
              requestedDates: stringArray(args.requestedDates),
              maxOptions: 3,
            });
            console.info(`Website bot availability for ${zip} (${availability.status}, ${availability.options.length}) in ${Date.now() - startedAt} ms`);
            reply(availability);
          } catch (error) {
            console.error("Website bot availability failed:", error instanceof Error ? error.message : error);
            reply({ error: error instanceof WebsiteBotConfigError ? "NOT_CONFIGURED" : "LOOKUP_FAILED", message: "Availability could not be checked right now. Apologize briefly and offer the phone number." });
          }
          continue;
        }

        if (call.function.name === "lookup_returning_customer") {
          const phone = typeof args.phone === "string" ? normalizePhone(args.phone) : null;
          const email = typeof args.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(args.email.trim()) ? args.email.trim() : null;
          if (!phone && !email) { reply({ matched: false, message: "Need a valid mobile number or email to check." }); continue; }
          if (!allowCustomerLookup(sessionId, ip)) { reply({ matched: false, message: "Lookup limit reached; treat as a new customer." }); continue; }
          try {
            const outcome = await lookupReturningCustomer({
              phone: phone || undefined,
              email: email || undefined,
              lastName: typeof args.lastName === "string" ? args.lastName.trim() : undefined,
              zip: typeof args.zip === "string" && /^\d{5}$/.test(args.zip.trim()) ? args.zip.trim() : undefined,
            });
            if (outcome.status === "ambiguous") {
              reply({ matched: false, ambiguous: true, message: "More than one record shares that number. Ask for their last name (and ZIP if you don't have it), then call lookup_returning_customer again with phone + lastName + zip." });
              continue;
            }
            if (outcome.status === "none") { reply({ matched: false, message: "No match. Continue as a new customer; do not say you looked them up." }); continue; }
            const found = outcome.customer;
            reply({
              matched: true,
              firstName: found.firstName,
              products: found.products,
              lastInstall: found.lastCompleted || null,
              customerRef: signCustomerRef(found),
              message: "Welcome them back by first name and mention what we installed (if any). Pass customerRef to prepare_booking. Skip 'how did you hear about us' (use 'Existing customer') and 'other options' (use 'Returning customer'). For rescheduling or canceling an existing appointment, ask them to call the office.",
            });
          } catch (error) {
            console.error("Website bot customer lookup failed:", error instanceof Error ? error.message : error);
            reply({ matched: false, message: "Lookup unavailable; continue as a new customer." });
          }
          continue;
        }

        if (call.function.name === "prepare_booking" && canBook) {
          const checked = validateBookingInput(args);
          if (!checked.ok) { reply({ error: "MISSING", missing: checked.missing, message: "Ask for these one at a time, then call prepare_booking again." }); continue; }
          if (!allowLookup(sessionId)) { reply({ error: "LOOKUP_LIMIT", message: "Too many scheduling checks in this chat. Offer the phone number." }); continue; }

          const input = checked.value;

          // The price range must really have been quoted in this chat, not
          // just filled in by the model at booking time.
          const priceFigure = (WEBSITE_BOT_PRICE_RANGE.match(/\d[\d,]*/) || [""])[0].replace(/,/g, "");
          const quoted = !priceFigure || messages.some((m) => m.role === "assistant" && m.content.replace(/,/g, "").includes(priceFigure));
          if (!quoted) {
            reply({ error: "MISSING", missing: ["quote the price range to the visitor first (say it in a message, then ask if that works for them)"], message: `You have not told the visitor the price range yet. Tell them now ("Most homeowners invest between ${WEBSITE_BOT_PRICE_RANGE} per door, depending on design and options"), ask whether that fits what they had in mind, and only call prepare_booking again after they answer.` });
            continue;
          }

          // Safety net: if the model didn't run the returning-customer lookup,
          // do it here with what we already have, so an existing customer is
          // booked under their record instead of being refused as a duplicate.
          let autoMatched = false;
          if (!input.existing) {
            try {
              const auto = await lookupReturningCustomer({
                phone: input.customer.phone,
                email: input.customer.email,
                lastName: input.customer.name.trim().split(/\s+/).pop(),
                zip: input.customer.zip,
              });
              if (auto.status === "matched") {
                input.existing = { customerId: auto.customer.customerId, locationId: auto.customer.locationId, firstName: auto.customer.firstName };
                autoMatched = true;
              }
            } catch (error) {
              console.warn("Website bot auto customer lookup skipped:", error instanceof Error ? error.message : error);
            }
          }

          // The model must have actually asked the questions it is answering.
          const notAsked = unaskedQuestions(messages, Boolean(input.existing));
          if (notAsked.length) {
            reply({ error: "MISSING", missing: notAsked, message: "You filled these answers without the visitor telling you. Ask them now, naturally and one or two at a time (not as a numbered list), wait for the answers, then call prepare_booking again with what they actually said." });
            continue;
          }

          // Returning customer: book at THEIR location for this address only.
          if (input.existing) {
            try {
              const locationId = await findCustomerLocationAtAddress(input.existing.customerId, {
                street: input.customer.street,
                city: input.customer.city,
                zip: input.customer.zip,
              });
              if (!locationId) {
                console.warn("Website bot: returning customer gave an address that is not one of their locations");
                reply({ error: "CANNOT_BOOK_ONLINE", message: `This returning customer gave an address we don't have on their account (they may have moved). Do not say why in detail. Say warmly that since it's a new address for their account, the team will set it up by phone, and give ${WEBSITE_BOT_PHONE}.` });
                continue;
              }
              input.existing = { ...input.existing, locationId };
            } catch (error) {
              console.error("Website bot location match failed:", error instanceof Error ? error.message : error);
              reply({ error: "PREPARE_FAILED", message: "Could not prepare the booking right now. Apologize briefly and offer the phone number." });
              continue;
            }
          }

          const fullAddress = `${input.customer.street}${input.customer.unit ? ` #${input.customer.unit}` : ""}, ${input.customer.city}, ${input.customer.state} ${input.customer.zip}`;
          try {
            const slot = await resolveSlotForBooking(fullAddress, input.date, input.arrivalWindow);
            if (!slot) {
              reply({ error: "SLOT_GONE", message: "That time is no longer open for this address. Apologize and run find_open_times again with the ZIP to offer fresh times." });
              continue;
            }
            const dry = await bookSalesAppointmentFromWebsite({ slot, customer: input.customer, qualifying: input.qualifying, customerNotes: input.customerNotes, dryRun: true, existing: input.existing });
            if (!dry.ok) {
              console.warn("Website bot dry run refused:", dry.code);
              const openJob = /OPEN_SALES_JOB|already has an open|open sales job/i.test(String(dry.code || ""));
              reply({
                error: "CANNOT_BOOK_ONLINE",
                message: openJob
                  ? "It looks like they already have a consultation on the books. Say so warmly and ask them to call the office to reschedule or add to it. Do not give details."
                  : "The booking can't be completed online for this visitor. Do not say why. Say the team will need to finish it by phone and give the phone number.",
              });
              continue;
            }
            const preview = previewFor(input);
            const token = signBookingTicket({ ...input, slot, sessionId });
            const sms = smsConsent();
            bookingCard = sms ? { token, preview, sms } : { token, preview };
            const pressWhat = sms
              ? "check the details, then tap \"Text me a code\" and enter the code we text to their mobile to finish booking"
              : "check the details and press Confirm to book";
            reply({
              status: "PREVIEW_READY",
              preview,
              returningCustomer: Boolean(input.existing),
              message: autoMatched
                ? `This visitor is an existing customer (${input.existing?.firstName || "returning"}); the booking will go under their record. Welcome them back in one short line, then tell them to ${pressWhat}. Do not say it is booked yet.`
                : `A preview card is now showing to the visitor. Briefly tell them to ${pressWhat}. Do not say it is booked yet.`,
            });
          } catch (error) {
            console.error("Website bot prepare_booking failed:", error instanceof Error ? error.message : error);
            reply({ error: "PREPARE_FAILED", message: "Could not prepare the booking right now. Apologize briefly and offer the phone number." });
          }
          continue;
        }

        reply({ error: "TOOL_NOT_AVAILABLE" });
      }
    }

    return json({ reply: "Let me get a team member to help with that. Please give us a call at 800-992-9938 and we'll sort it out." }, 200, origin);
  } catch (error) {
    console.error("Website bot crashed:", error instanceof Error ? error.message : error);
    return json({ error: "Sorry, something went wrong on our side. Please try again in a moment." }, 500, origin);
  }
}

/** The chat window shows raw text, so drop markdown the model sometimes adds. */
function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*\*\s+/gm, "- ");
}

/**
 * Qualifying questions the model must not answer on its own. Each counts as
 * covered when Denny asked it, or the visitor volunteered an answer.
 */
function unaskedQuestions(messages: ChatMessage[], returning: boolean): string[] {
  const asked = (re: RegExp) => messages.some((m) => m.role === "assistant" && re.test(m.content));
  const said = (re: RegExp) => messages.some((m) => m.role === "user" && re.test(m.content));
  const missing: string[] = [];

  const priorityAsked = asked(/most important|matters most|top priority|biggest priority|main goal|what are you hoping|security, appearance|appearance,? or/i);
  const prioritySaid = said(/\b(most important|matters most|mainly|mostly|main thing|priority|curb appeal|looks?|appearance|value|last(s|ing)? long|durab|break-?ins?|burglar|safety|keep (out|bugs)|airflow|fresh air|privacy|pets?)\b/i);
  if (!priorityAsked && !prioritySaid) missing.push("Q2: what matters most to them - security, appearance, or long-term value");

  const timelineAsked = asked(/how soon|timeline|time ?frame|fairly soon|gathering options|just (looking|researching)|when (are|were) you (hoping|looking|planning)|ready to (move|get started)/i);
  const timelineSaid = said(/\b(asap|as soon as|soon|right away|immediately|no rush|not in a hurry|this (week|month|year|summer|fall|spring|winter)|next (week|month|year)|in a (few|couple)|within|just (looking|researching|browsing)|gathering|weeks?|months?)\b/i);
  if (!timelineAsked && !timelineSaid) missing.push("Q4: whether they want to handle this fairly soon or are gathering options");

  if (!returning) {
    const otherAsked = asked(/other (options|companies|quotes|bids)|shopping around|looked at (any|other)|just starting|compar(e|ing) (options|companies)/i);
    const otherSaid = said(/\b(quote|quotes|bids?|other compan|another compan|shopping around|compar|just starting|first (one|company|call)|haven'?t looked)\b/i);
    if (!otherAsked && !otherSaid) missing.push("Q3: whether they've looked at other options or are just starting");
  }
  return missing;
}

function timeArg(value: unknown): string | undefined {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.length < 20);
  return out.length ? out.slice(0, 10) : undefined;
}
