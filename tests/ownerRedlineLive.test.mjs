// Run with: npm run test:owner
import test from "node:test";
import assert from "node:assert/strict";
import { addDays } from "../lib/ownerRedline.ts";
import { assembleRedline, findDepartures, pacificDay, pacificMidnightMs, parseUtc, regionOf } from "../lib/ownerRedlineLive.ts";

test("Pacific midnight handles PST and PDT", () => {
  assert.equal(new Date(pacificMidnightMs("2027-02-01")).toISOString(), "2027-02-01T08:00:00.000Z");
  assert.equal(new Date(pacificMidnightMs("2026-09-28")).toISOString(), "2026-09-28T07:00:00.000Z");
  assert.equal(pacificDay("2026-11-23T08:00:00.000Z"), "2026-11-23");
  assert.equal(parseUtc("2026-12-03T16:00:00.123456Z"), Date.parse("2026-12-03T16:00:00.123Z"));
  assert.equal(regionOf("NorCal - Security Install"), "NorCal");
  assert.equal(regionOf(null), "Other");
});

// 36 nightly snapshots, Oct 18 → Nov 23 2026. Job A installs, B cancels,
// C is sold mid-window and installed, D goes on Hold, E stays open past Feb 1.
function fixture() {
  const days = Array.from({ length: 37 }, (_, i) => addDays("2026-10-18", i));
  const cutoffs = days.map((day) => {
    const jobs = new Map();
    const add = (id, bucket, value, next = null) => jobs.set(id, { bucket, value, next });
    if (day <= "2026-11-02") add("A", "Active", 10000, "2026-11-02T16:00:00.000000Z");
    if (day <= "2026-11-09") add("B", "Active", 5000, null);
    if (day >= "2026-11-05" && day <= "2026-11-15") add("C", "Active", 8000, "2026-11-15T16:00:00.000000Z");
    add("D", day >= "2026-11-10" ? "Hold" : "Active", 7000);
    add("E", "Active", 400000, "2027-03-01T16:00:00.000000Z");
    add("F", "Active", 20000, "2027-01-20T16:00:00.000000Z");
    let allOpen = 0, hold = 0;
    for (const j of jobs.values()) { if (j.bucket === "Active") allOpen += j.value; if (j.bucket === "Hold") hold += j.value; }
    return { day, allOpen, hold, onTime: day !== "2026-11-01", jobs };
  });
  const jobInfo = new Map([
    ["A", { status: "Completed", buName: "NorCal - Security Install" }],
    ["B", { status: "Canceled", buName: "SoCal - Security Install" }],
    ["C", { status: "Completed", buName: "NorCal - Security Install" }],
    ["D", { status: "Hold", buName: "SoCal - Security Install" }],
    ["E", { status: "Scheduled", buName: "SoCal - Security Install" }],
    ["F", { status: "Scheduled", buName: "NorCal - Security Install" }],
  ]);
  const dailySales = new Map(days.map((d) => [d, d === "2026-11-04" ? 8000 : 1000]));
  dailySales.set("2026-11-10", null);
  return { cutoffs, jobInfo, dailySales };
}

test("departures are the day a job left the backlog", () => {
  const deps = findDepartures(fixture().cutoffs);
  assert.deepEqual(deps.map((d) => [d.jobId, d.day]).sort(), [["A", "2026-11-02"], ["B", "2026-11-09"], ["C", "2026-11-15"]]);
});

test("assembles today's backlog, 30-day sold/installed, scheduled, weeks and regions", () => {
  const { cutoffs, jobInfo, dailySales } = fixture();
  const s = assembleRedline({ cutoffs, jobInfo, dailySales, generatedAt: "2026-11-23T08:15:00Z", redline: 350000, targetDate: "2027-02-01" });
  assert.equal(s.snapshotDate, "2026-11-23");
  assert.equal(s.backlog, 420000);            // E + F; D is on Hold
  assert.equal(s.holdBacklog, 7000);
  assert.equal(s.scheduledThroughTarget, 20000); // only F's next install is before Feb 1
  assert.equal(s.last30.start, "2026-10-24");
  assert.equal(s.last30.end, "2026-11-22");
  assert.equal(s.last30.installed, 18000);    // A + C; B canceled, D held
  assert.equal(s.last30.sold, 29 * 1000 - 1000 + 8000); // 30 days, one day 8,000, one day missing
  assert.equal(s.last30.backlogAtStart, 442000); // A + B + D + E + F on Oct 24
  assert.ok(s.notes.some((n) => /\$5,000 was canceled/.test(n)));
  assert.ok(s.notes.some((n) => /1 of 30 days had no sales/.test(n)));
  const mondays = s.weeks.map((w) => w.weekStart);
  assert.equal(mondays.at(-1), "2026-11-23");
  assert.equal(s.weeks.at(-1).sold, null);     // current week not finished
  const nov9 = s.weeks.find((w) => w.weekStart === "2026-11-09");
  assert.equal(nov9.installed, 8000);          // C left on Nov 15
  assert.equal(nov9.sold, 6000);               // Nov 10 missing
  const norcal = s.regions.find((r) => r.name === "NorCal");
  assert.deepEqual([norcal.backlog, norcal.installed30, norcal.sold30], [20000, 18000, 8000]);
  const socal = s.regions.find((r) => r.name === "SoCal");
  assert.equal(socal.backlog, 400000);
});

test("refuses to guess with under a week of snapshots", () => {
  const { cutoffs, jobInfo, dailySales } = fixture();
  assert.throws(() => assembleRedline({ cutoffs: cutoffs.slice(-5), jobInfo, dailySales, generatedAt: "2026-11-23T08:15:00Z", redline: 350000, targetDate: "2027-02-01" }), /Fewer than 7 days/);
});
