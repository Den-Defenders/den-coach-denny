// Owner Dashboard · Feb 1 redline tracker (Security installs only).
//
// Mike's goal (Nov 2026): keep at least $350K of sold-but-not-installed
// Security work on the books on Feb 1, cut overtime, and keep installs from
// out-pacing sales. This file holds the snapshot format and every number the
// tracker shows, as plain functions with no app imports so they can be tested
// directly with `npm run test:owner`.
//
// Definitions (match the verified weekly installation pipeline):
// - Backlog: full sold value of open "Returning to Install Security Products"
//   jobs (type 2054262) at the Monday 12:00 AM Pacific cutoff. Not completed,
//   not canceled, not on Hold, not RMA/remake, not a non-sale visit.
// - Sold: newly sold Security RTI value in the period.
// - Installed: full sold value of RTI jobs completed in the period.
// - Hold is reported beside the backlog and never added to it.

export const DEFAULT_REDLINE = 350_000;
export const DEFAULT_TARGET_DATE = "2027-02-01";

export type RedlineWeek = {
  weekStart: string;
  sold: number | null;
  installed: number | null;
  backlogAtStart: number | null;
};

export type RedlineRegion = {
  name: string;
  backlog: number | null;
  sold30: number | null;
  installed30: number | null;
  weeksOut: number | null;
};

export type RedlineSnapshot = {
  kind: "owner-redline";
  schemaVersion: 1;
  snapshotDate: string;
  generatedAt: string;
  source: string;
  notes: string[];
  redline: number;
  targetDate: string;
  backlog: number;
  holdBacklog: number | null;
  scheduledThroughTarget: number | null;
  last30: { start: string; end: string; sold: number; installed: number; backlogAtStart: number | null };
  weeks: RedlineWeek[];
  regions: RedlineRegion[];
};

const DAY = 86_400_000;

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function daysBetween(start: string, end: string) {
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY);
}

export function addDays(day: string, days: number) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function isMonday(day: string) {
  return new Date(`${day}T12:00:00Z`).getUTCDay() === 1;
}

function money(value: unknown, field: string, { nullable = false } = {}): number | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new Error(`${field} is required.`);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) {
    throw new Error(`${field} must be a dollar amount of zero or more.`);
  }
  return Math.round(value * 100) / 100;
}

function text(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${field} is missing or too long.`);
  return value.trim();
}

/** Validates an imported Monday snapshot. Unknown numbers must be null, never 0. */
export function parseRedlineSnapshot(input: unknown): RedlineSnapshot {
  if (!input || typeof input !== "object") throw new Error("Expected a redline snapshot JSON object.");
  const raw = input as Record<string, unknown>;
  if (raw.kind !== "owner-redline" || raw.schemaVersion !== 1) {
    throw new Error('Snapshot must have kind "owner-redline" and schemaVersion 1.');
  }
  if (!validDay(raw.snapshotDate) || !isMonday(raw.snapshotDate)) {
    throw new Error("snapshotDate must be a Monday (the 12:00 AM Pacific cutoff).");
  }
  const snapshotDate = raw.snapshotDate;
  if (typeof raw.generatedAt !== "string" || Number.isNaN(Date.parse(raw.generatedAt))) {
    throw new Error("generatedAt must be a timestamp.");
  }
  const targetDate = raw.targetDate === undefined ? DEFAULT_TARGET_DATE : raw.targetDate;
  if (!validDay(targetDate) || targetDate <= snapshotDate) throw new Error("targetDate must be a date after snapshotDate.");
  const redline = raw.redline === undefined ? DEFAULT_REDLINE : money(raw.redline, "redline")!;
  if (redline <= 0) throw new Error("redline must be more than zero.");
  const notes = raw.notes === undefined ? [] : raw.notes;
  if (!Array.isArray(notes) || notes.length > 30 || notes.some((n) => typeof n !== "string" || n.length > 1500)) {
    throw new Error("notes must be a short list of text.");
  }

  const last30Raw = raw.last30 as Record<string, unknown> | undefined;
  if (!last30Raw || typeof last30Raw !== "object") throw new Error("last30 is required.");
  if (!validDay(last30Raw.start) || !validDay(last30Raw.end) || last30Raw.end < last30Raw.start) {
    throw new Error("last30.start and last30.end must be dates, start first.");
  }
  if (last30Raw.end > snapshotDate) throw new Error("last30 cannot end after the snapshot date.");
  const windowDays = daysBetween(last30Raw.start, last30Raw.end) + 1;
  if (windowDays < 7 || windowDays > 62) throw new Error("last30 must cover 7 to 62 days.");

  const weeksRaw = raw.weeks === undefined ? [] : raw.weeks;
  if (!Array.isArray(weeksRaw) || weeksRaw.length > 60) throw new Error("weeks must be a list of up to 60 Mondays.");
  const seen = new Set<string>();
  const weeks = weeksRaw.map((w, i) => {
    const row = (w || {}) as Record<string, unknown>;
    if (!validDay(row.weekStart) || !isMonday(row.weekStart) || row.weekStart > snapshotDate || seen.has(row.weekStart)) {
      throw new Error(`weeks[${i}].weekStart must be a unique Monday on or before the snapshot.`);
    }
    seen.add(row.weekStart);
    return {
      weekStart: row.weekStart,
      sold: money(row.sold, `weeks[${i}].sold`, { nullable: true }),
      installed: money(row.installed, `weeks[${i}].installed`, { nullable: true }),
      backlogAtStart: money(row.backlogAtStart, `weeks[${i}].backlogAtStart`, { nullable: true }),
    };
  }).sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  const regionsRaw = raw.regions === undefined ? [] : raw.regions;
  if (!Array.isArray(regionsRaw) || regionsRaw.length > 12) throw new Error("regions must be a list of up to 12.");
  const regions = regionsRaw.map((r, i) => {
    const row = (r || {}) as Record<string, unknown>;
    const weeksOut = row.weeksOut === null || row.weeksOut === undefined ? null : row.weeksOut;
    if (weeksOut !== null && (typeof weeksOut !== "number" || !Number.isFinite(weeksOut) || weeksOut < 0 || weeksOut > 52)) {
      throw new Error(`regions[${i}].weeksOut must be 0 to 52 or null.`);
    }
    return {
      name: text(row.name, `regions[${i}].name`, 60),
      backlog: money(row.backlog, `regions[${i}].backlog`, { nullable: true }),
      sold30: money(row.sold30, `regions[${i}].sold30`, { nullable: true }),
      installed30: money(row.installed30, `regions[${i}].installed30`, { nullable: true }),
      weeksOut: weeksOut as number | null,
    };
  });

  return {
    kind: "owner-redline",
    schemaVersion: 1,
    snapshotDate,
    generatedAt: raw.generatedAt,
    source: text(raw.source, "source", 300),
    notes: notes as string[],
    redline,
    targetDate,
    backlog: money(raw.backlog, "backlog")!,
    holdBacklog: money(raw.holdBacklog, "holdBacklog", { nullable: true }),
    scheduledThroughTarget: money(raw.scheduledThroughTarget, "scheduledThroughTarget", { nullable: true }),
    last30: {
      start: last30Raw.start,
      end: last30Raw.end,
      sold: money(last30Raw.sold, "last30.sold")!,
      installed: money(last30Raw.installed, "last30.installed")!,
      backlogAtStart: money(last30Raw.backlogAtStart, "last30.backlogAtStart", { nullable: true }),
    },
    weeks,
    regions,
  };
}

export type RedlineStatus = "safe" | "close" | "below";

export type RedlineMath = {
  weeksLeft: number;
  windowDays: number;
  salesPerWeek: number;
  installsPerWeek: number;
  /** Installed minus sold over the last 30 days. Positive = installs out-paced sales. */
  outpaceGap: number;
  /** outpaceGap as a share of sales (0.37 = installs ran 37% ahead of sales). */
  outpacePct: number | null;
  /** Sold ÷ installed. 1.00 is even; under 1 uses up backlog. */
  ratio: number | null;
  /** Backlog on the target date if the last 30 days' pace continues. */
  projectedAtTarget: number;
  cushion: number;
  status: RedlineStatus;
  /** Total install dollars that can be done before the target and still land on the redline. */
  installRoom: number;
  /** installRoom spread evenly over the weeks left. */
  allowancePerWeek: number;
  /** How much the install pace must come down per week (0 when already within the allowance). */
  installCutPerWeek: number;
  /** Weekly sales needed to land on the redline at the current install pace. */
  salesNeededPerWeek: number;
  /** installRoom minus installs already on the calendar before the target (null when unknown). */
  roomLeftToBook: number | null;
  /** The week the projection first drops below the redline (null when it never does). */
  crossesRedline: string | null;
  backlog30DaysAgo: number | null;
  backlogChange30: number | null;
  projection: { date: string; backlog: number }[];
};

export function redlineMath(s: RedlineSnapshot): RedlineMath {
  const windowDays = daysBetween(s.last30.start, s.last30.end) + 1;
  const daysLeft = Math.max(0, daysBetween(s.snapshotDate, s.targetDate));
  const weeksLeft = daysLeft / 7;
  const salesPerWeek = s.last30.sold / windowDays * 7;
  const installsPerWeek = s.last30.installed / windowDays * 7;
  const projectedAtTarget = Math.max(0, s.backlog + (salesPerWeek - installsPerWeek) * weeksLeft);
  const cushion = projectedAtTarget - s.redline;
  const status: RedlineStatus = cushion < 0 ? "below" : cushion < s.redline * 0.1 ? "close" : "safe";
  const installRoom = Math.max(0, s.backlog + salesPerWeek * weeksLeft - s.redline);
  const allowancePerWeek = weeksLeft > 0 ? installRoom / weeksLeft : 0;
  const salesNeededPerWeek = weeksLeft > 0
    ? Math.max(0, installsPerWeek - (s.backlog - s.redline) / weeksLeft)
    : 0;

  const projection: { date: string; backlog: number }[] = [];
  let crossesRedline: string | null = null;
  for (let d = 0; d <= daysLeft; d += 7) {
    const date = addDays(s.snapshotDate, d);
    const backlog = Math.max(0, s.backlog + (salesPerWeek - installsPerWeek) * (d / 7));
    projection.push({ date, backlog });
    if (crossesRedline === null && backlog < s.redline) crossesRedline = date;
  }
  if (projection.at(-1)?.date !== s.targetDate) {
    projection.push({ date: s.targetDate, backlog: projectedAtTarget });
    if (crossesRedline === null && projectedAtTarget < s.redline) crossesRedline = s.targetDate;
  }

  const backlog30DaysAgo = s.last30.backlogAtStart ?? closestBacklog(s.weeks, s.last30.start);
  return {
    weeksLeft,
    windowDays,
    salesPerWeek,
    installsPerWeek,
    outpaceGap: s.last30.installed - s.last30.sold,
    outpacePct: s.last30.sold > 0 ? (s.last30.installed - s.last30.sold) / s.last30.sold : null,
    ratio: s.last30.installed > 0 ? s.last30.sold / s.last30.installed : null,
    projectedAtTarget,
    cushion,
    status,
    installRoom,
    allowancePerWeek,
    installCutPerWeek: Math.max(0, installsPerWeek - allowancePerWeek),
    salesNeededPerWeek,
    roomLeftToBook: s.scheduledThroughTarget === null ? null : installRoom - s.scheduledThroughTarget,
    crossesRedline,
    backlog30DaysAgo,
    backlogChange30: backlog30DaysAgo === null ? null : s.backlog - backlog30DaysAgo,
    projection,
  };
}

function closestBacklog(weeks: RedlineWeek[], day: string) {
  let best: RedlineWeek | null = null;
  for (const w of weeks) {
    if (w.backlogAtStart === null) continue;
    if (!best || Math.abs(daysBetween(w.weekStart, day)) < Math.abs(daysBetween(best.weekStart, day))) best = w;
  }
  return best && Math.abs(daysBetween(best.weekStart, day)) <= 4 ? best.backlogAtStart : null;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Ready-to-paste Monday update for Mike, in Steven's Slack format. */
export function mondaySlackUpdate(s: RedlineSnapshot, m = redlineMath(s)) {
  const lines = [
    `📅 *Feb 1 Redline Update – week of ${shortDay(s.snapshotDate)}*`,
    "",
    "*Where we stand*",
    `• Sold backlog today: ${usd(s.backlog)}${s.holdBacklog !== null ? ` (plus ${usd(s.holdBacklog)} on Hold, not counted)` : ""}`,
    `• Projected on ${shortDay(s.targetDate)}: ${usd(m.projectedAtTarget)} vs ${usd(s.redline)} redline`,
    m.cushion >= 0
      ? `• ⭐ ${usd(m.cushion)} above the redline at the current pace`
      : `• ⚠ ${usd(-m.cushion)} below the redline at the current pace${m.crossesRedline ? ` (crosses the line the week of ${shortDay(m.crossesRedline)})` : ""}`,
  ];
  if (m.backlogChange30 !== null) {
    lines.push(`• Backlog 30 days ago: ${usd(m.backlog30DaysAgo!)} (${m.backlogChange30 >= 0 ? "up" : "down"} ${usd(Math.abs(m.backlogChange30))})`);
  }
  lines.push(
    "",
    `*Last 30 days (${shortDay(s.last30.start)} – ${shortDay(s.last30.end)})*`,
    `• Sold: ${usd(s.last30.sold)}`,
    `• Installed: ${usd(s.last30.installed)}`,
    m.outpaceGap > 0
      ? `• ⚠ Installs out-paced sales by ${usd(m.outpaceGap)}${m.outpacePct !== null ? ` (${Math.round(m.outpacePct * 100)}%)` : ""}`
      : `• ⭐ Sales kept up with installs (${usd(-m.outpaceGap)} more sold than installed)`,
    "",
    "*To land on the redline*",
    `• Install allowance: ${usd(m.allowancePerWeek)}/week (now running ${usd(m.installsPerWeek)}/week)`,
  );
  if (m.installCutPerWeek > 0) lines.push(`• Bring installs down about ${usd(m.installCutPerWeek)}/week, or sell ${usd(m.salesNeededPerWeek)}/week (now ${usd(m.salesPerWeek)}/week)`);
  if (m.roomLeftToBook !== null) {
    lines.push(m.roomLeftToBook >= 0
      ? `• Room left to book before ${shortDay(s.targetDate)}: ${usd(m.roomLeftToBook)}`
      : `• ⚠ Already booked ${usd(-m.roomLeftToBook)} more than the room before ${shortDay(s.targetDate)}`);
  }
  const outpaced = s.regions.filter((r) => r.sold30 !== null && r.installed30 !== null && r.installed30 > r.sold30);
  if (outpaced.length) {
    lines.push("", "*Regions where installs out-paced sales*");
    for (const r of outpaced) lines.push(`• ${r.name}: sold ${usd(r.sold30!)}, installed ${usd(r.installed30!)}${r.weeksOut !== null ? ` · ${r.weeksOut} wk out` : ""}`);
  }
  return lines.join("\n");
}
