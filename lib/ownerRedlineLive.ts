// Builds the Feb 1 redline snapshot from the owner report collector's nightly
// job-level snapshots (servicetitan-mcp/owner_report, Vercel Cron at 12:10 AM PT).
// The collector stores, for every Pacific midnight, each open RTI job with its
// bucket (Active / Hold / ...), full sold value and next install date.
//
// - Backlog = the Active total at the newest midnight (the collector's own
//   `all_open`; Hold kept separate).
// - Installed = jobs that were Active one midnight and gone the next, where the
//   job's ServiceTitan status is now Completed. Canceled ones are tracked apart.
// - Sold = the dashboard's own daily "sales" (new Security RTI value by day).
// - Region = the part of the business unit name before " - "
//   ("NorCal - Security Install" → NorCal).
//
// Pure functions only (no app imports) so tests can run them directly.

import { addDays, daysBetween, parseRedlineSnapshot, type RedlineSnapshot } from "./ownerRedline.ts";

export type SnapshotJob = { bucket: string; value: number | null; next: string | null };
export type NightlyCutoff = {
  /** Pacific calendar date whose 12:00 AM this snapshot was taken at. */
  day: string;
  allOpen: number;
  hold: number | null;
  onTime: boolean;
  jobs: Map<string, SnapshotJob>;
};
export type JobInfo = { status: string | null; buName: string | null };
export type Departure = { day: string; jobId: string; value: number };

/** Midnight Pacific at the start of `day`, as UTC milliseconds (handles PST/PDT). */
export function pacificMidnightMs(day: string) {
  for (const offset of [8, 7]) {
    const ms = Date.parse(`${day}T${String(offset).padStart(2, "0")}:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
    if (Number(parts) === 0) return ms;
  }
  return Date.parse(`${day}T08:00:00Z`);
}

/** Pacific calendar date of a UTC timestamp. */
export function pacificDay(utc: string | number | Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(utc));
}

/** Python writes 6 fraction digits; trim to milliseconds before parsing. */
export function parseUtc(value: string | null) {
  if (!value) return null;
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(ms) ? null : ms;
}

export function regionOf(buName: string | null | undefined) {
  const name = (buName || "").split(" - ")[0].trim();
  return name || "Other";
}

/** Jobs that were Active at one midnight and missing from every bucket at the next. */
export function findDepartures(cutoffs: NightlyCutoff[]): Departure[] {
  const out: Departure[] = [];
  for (let i = 1; i < cutoffs.length; i++) {
    const prev = cutoffs[i - 1], cur = cutoffs[i];
    for (const [jobId, job] of prev.jobs) {
      if (job.bucket === "Active" && job.value !== null && !cur.jobs.has(jobId)) {
        out.push({ day: addDays(cur.day, -1), jobId, value: job.value });
      }
    }
  }
  return out;
}

/** Jobs that turned Active (from not open, or not yet valued) between two midnights. Hold releases don't count. */
function findArrivals(cutoffs: NightlyCutoff[]) {
  const out: Departure[] = [];
  for (let i = 1; i < cutoffs.length; i++) {
    const prev = cutoffs[i - 1], cur = cutoffs[i];
    for (const [jobId, job] of cur.jobs) {
      const before = prev.jobs.get(jobId)?.bucket;
      if (job.bucket === "Active" && job.value !== null && before !== "Active" && before !== "Hold" && before !== "Unverifiable-hold") {
        out.push({ day: addDays(cur.day, -1), jobId, value: job.value });
      }
    }
  }
  return out;
}

const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function assembleRedline(input: {
  cutoffs: NightlyCutoff[];
  jobInfo: Map<string, JobInfo>;
  dailySales: Map<string, number | null>;
  generatedAt: string;
  redline: number;
  targetDate: string;
}): RedlineSnapshot {
  const cutoffs = [...input.cutoffs].sort((a, b) => a.day.localeCompare(b.day));
  const latest = cutoffs.at(-1);
  if (!latest) throw new Error("No nightly snapshots have been saved yet.");
  const end = addDays(latest.day, -1);
  const startCut = cutoffs.find((c) => c.day >= addDays(latest.day, -30));
  if (!startCut || daysBetween(startCut.day, latest.day) < 7) {
    throw new Error("Fewer than 7 days of nightly snapshots are saved, so the 30-day comparison can't be made yet.");
  }
  const start = startCut.day;
  const inWindow = (day: string, from: string, to: string) => day >= from && day <= to;
  const statusOf = (id: string) => (input.jobInfo.get(id)?.status || "").toLowerCase();

  const departures = findDepartures(cutoffs);
  const installedDeps = departures.filter((d) => statusOf(d.jobId) === "completed");
  const canceledDeps = departures.filter((d) => statusOf(d.jobId) === "canceled");
  const otherDeps = departures.filter((d) => !["completed", "canceled"].includes(statusOf(d.jobId)));
  const arrivals = findArrivals(cutoffs);

  const salesBetween = (from: string, to: string) => {
    let total = 0, missing = 0, days = 0;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      days++;
      const v = input.dailySales.get(d);
      if (v === null || v === undefined) missing++; else total += v;
    }
    return { total: Math.round(total * 100) / 100, missing, days };
  };

  const sold30 = salesBetween(start, end);
  const installed30 = sum(installedDeps.filter((d) => inWindow(d.day, start, end)).map((d) => d.value));
  const canceled30 = sum(canceledDeps.filter((d) => inWindow(d.day, start, end)).map((d) => d.value));
  const other30 = sum(otherDeps.filter((d) => inWindow(d.day, start, end)).map((d) => d.value));

  const targetMs = pacificMidnightMs(input.targetDate);
  let scheduled = 0;
  for (const job of latest.jobs.values()) {
    const next = parseUtc(job.next);
    if (job.bucket === "Active" && job.value !== null && next !== null && next < targetMs) scheduled += job.value;
  }

  const mondays = cutoffs.filter((c) => new Date(`${c.day}T12:00:00Z`).getUTCDay() === 1).slice(-9);
  const weeks = mondays.map((m) => {
    const weekEnd = addDays(m.day, 6);
    const complete = weekEnd <= end;
    const sales = complete ? salesBetween(m.day, weekEnd) : null;
    return {
      weekStart: m.day,
      sold: sales && sales.missing < sales.days ? sales.total : null,
      installed: complete ? sum(installedDeps.filter((d) => inWindow(d.day, m.day, weekEnd)).map((d) => d.value)) : null,
      backlogAtStart: m.allOpen,
    };
  });

  const regionMap = new Map<string, { backlog: number; sold30: number; installed30: number }>();
  const regionRow = (id: string) => {
    const name = regionOf(input.jobInfo.get(id)?.buName);
    if (!regionMap.has(name)) regionMap.set(name, { backlog: 0, sold30: 0, installed30: 0 });
    return regionMap.get(name)!;
  };
  for (const [id, job] of latest.jobs) if (job.bucket === "Active" && job.value !== null) regionRow(id).backlog += job.value;
  for (const d of installedDeps) if (inWindow(d.day, start, end)) regionRow(d.jobId).installed30 += d.value;
  for (const a of arrivals) if (inWindow(a.day, start, end)) regionRow(a.jobId).sold30 += a.value;
  const regions = [...regionMap.entries()]
    .filter(([, r]) => r.backlog || r.sold30 || r.installed30)
    .sort((a, b) => b[1].backlog - a[1].backlog)
    .slice(0, 12)
    .map(([name, r]) => ({ name, backlog: Math.round(r.backlog * 100) / 100, sold30: Math.round(r.sold30 * 100) / 100,
      installed30: Math.round(r.installed30 * 100) / 100, weeksOut: null }));

  const late = cutoffs.filter((c) => !c.onTime && c.day >= start).length;
  const notes = [
    `Installed = full sold value of jobs that left the open backlog and are now Completed in ServiceTitan (${usd(installed30)} in the last ${daysBetween(start, end) + 1} days).`,
    canceled30 > 0 ? `${usd(canceled30)} was canceled off the backlog in the same days. It lowers the backlog but is not counted as installed.` : "No canceled jobs left the backlog in the last 30 days.",
    ...(other30 > 0 ? [`${usd(other30)} left the backlog for other reasons (status changed, re-valued or no longer an install job).`] : []),
    `Install revenue before ${input.targetDate} counts open jobs whose next install appointment is before then.`,
    "Region sold = new install jobs that showed up in the nightly snapshots, by business unit. The total Sold uses the dashboard's daily Security sales.",
    ...(sold30.missing ? [`${sold30.missing} of ${sold30.days} days had no sales figure and count as $0.`] : []),
    ...(late ? [`${late} nightly snapshot(s) in the window were captured late or rebuilt, so they are reconstructed, not verified.`] : []),
  ];

  return parseRedlineSnapshot({
    kind: "owner-redline",
    schemaVersion: 1,
    snapshotDate: latest.day,
    generatedAt: input.generatedAt,
    source: "ServiceTitan nightly snapshot (owner report collector, 12:10 AM PT)",
    notes,
    redline: input.redline,
    targetDate: input.targetDate,
    backlog: latest.allOpen,
    holdBacklog: latest.hold,
    scheduledThroughTarget: Math.round(scheduled * 100) / 100,
    last30: { start, end, sold: sold30.total, installed: installed30, backlogAtStart: startCut.allOpen },
    weeks,
    regions,
  });
}
