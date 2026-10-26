/**
 * lib/ai/companyFacts.ts
 *
 * ONE place for the company facts every customer AI may state: prices,
 * inclusions, warranty, financing, service-area rules, phone and links.
 * The texting bot uses it now; the website chat bot moves to it next (PR C),
 * so both always say the same thing.
 *
 * A price or link change is a one-line edit here. Keep each fact's source and
 * date in the comment next to it (Mike's handoff doc: facts must be traceable).
 */

export const COMPANY_FACTS = {
  // Contact (office line on every Den Defenders HELP reply).
  phone: (process.env.SMS_BOT_OFFICE_PHONE || "(800) 992-9938").trim(),
  email: "contact@dendefenders.com",

  // Prices. Steven, 2026-10-26 (final for now).
  /** Every swinging security door (Centurion, Artisan, WoodHaven) and VistaLuxe, per door. */
  perDoor: "$3,800 to $5,300",
  /** Double / French set or two doors = per-door price twice. */
  doubleDoor: "$7,600 to $10,600",
  slider: "starting at about $4,300",
  windowScreens: "starting at about $600",
  /** What a door price includes (Mike's example, 2026-10-26). */
  doorInclusions: "the door, hardware, installation and tax",
  /** Why the final price varies. */
  priceVaries: "Each one is custom-built for your entry, so the final price depends on the design and options you pick.",

  // Warranty (estimates + audit decision 2026-10-22).
  securityWarranty: "Lifetime No Break-In Guarantee plus a 10-year workmanship warranty",
  vistaLuxeWarranty: "10-year workmanship warranty",

  // Financing (Mike/Steven, 2026-10-25). Always "on approved credit".
  financing: "$0 down and 0% interest for 12 months, on approved credit",

  // Discounts (2026-10-22): only when the customer asks.
  veteranDiscount: "5% veteran discount (active military too), applied by the team on the call",

  // Links.
  catalog: "https://simplebooklet.com/junesummerbook2026redesign1",
  gallery: "https://dendefenders.com/gallery/",
  financingPage: "https://dendefenders.com/financing/",
  smsTerms: "https://dendefenders.com/sms-terms/",
  privacy: "https://dendefenders.com/privacy-policy/",
};

/**
 * Nevada (Steven, 2026-10-26): only Reno and Las Vegas (Henderson counts as
 * Las Vegas), and only jobs of at least 2 doors. Cities in NV_ASK_TEAM_CITIES
 * (next door to those two) go to the team to decide; every other Nevada city
 * is not served.
 */
export const NV_SERVED_CITIES = new Set(["reno", "las vegas", "henderson"]);
export const NV_ASK_TEAM_CITIES = new Set(["north las vegas", "sparks"]);
export const NV_MIN_DOORS = 2;

const F = COMPANY_FACTS;

/** The facts block for customer AI prompts. Same text every request (caches well). */
export function companyFactsText(): string {
  return `COMPANY FACTS (approved; use these exact numbers, never others)
PRICES
- Swinging security door (Centurion, Artisan or WoodHaven): ${F.perDoor} per door, including ${F.doorInclusions}. ${F.priceVaries}
- Double door (French set) or two doors: priced per door, so about ${F.doubleDoor}, same inclusions.
- VistaLuxe storm door: same as a security door, ${F.perDoor} per door, same inclusions.
- Sliding security door: ${F.slider}.
- Security window screens: ${F.windowScreens}.
- Exact prices come from the free in-home design consultation after measuring. Never calculate totals, never quote a lower "starting at" number for a door, never invent upgrade prices.
WARRANTY
- Security doors, security sliders and security window screens: ${F.securityWarranty}.
- VistaLuxe storm door: ${F.vistaLuxeWarranty} only.
- The team decides whether any claim is covered.
FINANCING (bring up only after price has come up, or when they ask about payments)
- ${F.financing}. Never promise approval, quote monthly payments or deposits, or invent other terms. Page: ${F.financingPage}
DISCOUNTS (only when they ask about discounts, deals or promotions; never first)
- ${F.veteranDiscount}. No other offers; the team decides any multi-door offer.
NEVADA
- We serve only the Reno and Las Vegas areas (Henderson included), and only projects with at least ${NV_MIN_DOORS} doors. A single-door project there gets a kind no.
CONTACT AND LINKS (exact URLs only; never invent one)
- Office phone: ${F.phone}. Email for job applicants and vendors: ${F.email}
- Catalog (styles and photos): ${F.catalog}
- Gallery of installed doors: ${F.gallery}
- SMS terms: ${F.smsTerms}  Privacy policy: ${F.privacy}`;
}
