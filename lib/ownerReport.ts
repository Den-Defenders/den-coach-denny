export type PeriodRow = {
  date: string;
  revenuePipeline: number | null;
  cashflowPipeline: number | null;
  holdRevenue: number | null;
  holdCashflow: number | null;
  unscheduledRevenue: number | null;
  beyondWindowRevenue: number | null;
  jobCount: number | null;
  sales: number | null;
  deposits: number | null;
  installPayments: number | null;
  refunds: number | null;
  netCash: number | null;
  quality: "verified" | "reconstructed" | "forecast";
};

export type OwnerReport = {
  schemaVersion: 1;
  generatedAt: string;
  source: string;
  notes: string[];
  weekly: PeriodRow[];
  daily: PeriodRow[];
  dailyRolling?: PeriodRow[];
};

const MONEY = ["revenuePipeline", "cashflowPipeline", "holdRevenue", "holdCashflow",
  "unscheduledRevenue", "beyondWindowRevenue", "sales", "deposits",
  "installPayments", "refunds", "netCash"] as const;
const COLUMNS = [...MONEY, "jobCount"] as const;

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^20(24|25|26|27)-\d{2}-\d{2}$/.test(value) || value > "2027-03-31") return false;
  return !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

function parseRows(value: unknown, weekly: boolean): PeriodRow[] {
  if (!Array.isArray(value) || value.length > 1600) throw new Error("Invalid report rows or too many rows.");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Each row must be an object.");
    const row = raw as Record<string, unknown>;
    if (!validDay(row.date) || seen.has(row.date)) throw new Error(`Duplicate or invalid date: ${String(row.date)}`);
    seen.add(row.date);
    if (weekly && new Date(`${row.date}T12:00:00Z`).getUTCDay() !== 1) {
      throw new Error(`Weekly snapshot must be a Monday: ${row.date}`);
    }
    if (row.quality !== "verified" && row.quality !== "reconstructed" && row.quality !== "forecast") {
      throw new Error(`Missing quality for ${row.date}`);
    }
    const normalized = { date: row.date, quality: row.quality } as PeriodRow;
    for (const key of COLUMNS) {
      const amount = row[key];
      if (amount !== null && (typeof amount !== "number" || !Number.isFinite(amount) ||
          Math.abs(amount) > 1e10 || (key === "jobCount" && (!Number.isInteger(amount) || amount < 0)))) {
        throw new Error(`${key} must be a number or null on ${row.date}`);
      }
      normalized[key] = amount as never;
    }
    for (const key of ["revenuePipeline", "cashflowPipeline", "holdRevenue", "holdCashflow",
      "unscheduledRevenue", "beyondWindowRevenue", "sales", "deposits", "installPayments", "refunds"] as const) {
      if (normalized[key] !== null && normalized[key] < 0) throw new Error(`${key} cannot be negative on ${row.date}`);
    }
    if (normalized.revenuePipeline !== null && normalized.cashflowPipeline !== null &&
        normalized.cashflowPipeline > normalized.revenuePipeline + .01) {
      throw new Error(`Unpaid cash exceeds sold revenue on ${row.date}`);
    }
    if ([normalized.deposits, normalized.installPayments, normalized.refunds, normalized.netCash].every((n) => n !== null) &&
      Math.abs(normalized.deposits! + normalized.installPayments! - normalized.refunds! - normalized.netCash!) > .02) {
      throw new Error(`Net cash does not reconcile on ${row.date}`);
    }
    return normalized;
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function parseOwnerReport(input: unknown): OwnerReport {
  if (!input || typeof input !== "object") throw new Error("Expected a JSON report object.");
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || typeof raw.source !== "string" || raw.source.length < 3 || raw.source.length > 300 ||
      typeof raw.generatedAt !== "string" || Number.isNaN(Date.parse(raw.generatedAt)) ||
      !Array.isArray(raw.notes) || raw.notes.length > 40 ||
      raw.notes.some((note) => typeof note !== "string" || note.length > 2000)) {
    throw new Error("Invalid schemaVersion, generatedAt, source or notes.");
  }
  const weekly = parseRows(raw.weekly, true);
  const daily = parseRows(raw.daily, false);
  const dailyRolling = raw.dailyRolling === undefined ? undefined : parseRows(raw.dailyRolling, false);
  const pacificParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(raw.generatedAt));
  const piece = (type: string) => pacificParts.find((part) => part.type === type)?.value || "";
  const asOfDay = `${piece("year")}-${piece("month")}-${piece("day")}`;
  for (const row of [...weekly, ...daily, ...(dailyRolling || [])]) {
    if (row.date > asOfDay && row.quality !== "forecast") {
      throw new Error(`Future row ${row.date} must be labeled forecast.`);
    }
    if (row.date < asOfDay && row.quality === "forecast") {
      throw new Error(`Historical row ${row.date} cannot be labeled forecast.`);
    }
  }
  return {
    schemaVersion: 1, generatedAt: raw.generatedAt, source: raw.source,
    notes: raw.notes as string[], weekly, daily, ...(dailyRolling ? { dailyRolling } : {}),
  };
}
