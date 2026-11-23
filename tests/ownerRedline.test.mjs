// Run with: npm run test:owner
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRedlineSnapshot, parseRedlineGoal, redlineMath, mondaySlackUpdate } from "../lib/ownerRedline.ts";

const example = JSON.parse(readFileSync(new URL("../docs/owner-redline-snapshot.example.json", import.meta.url), "utf8"));
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test("example snapshot parses with defaults kept", () => {
  const s = parseRedlineSnapshot(example);
  assert.equal(s.redline, 350000);
  assert.equal(s.targetDate, "2027-02-01");
  assert.equal(s.weeks.at(-1).sold, null);
});

test("math: 10 weeks to Feb 1, pace projection, allowance, outpace", () => {
  const m = redlineMath(parseRedlineSnapshot(example));
  near(m.weeksLeft, 10, 1e-9);
  near(m.salesPerWeek, 190000 / 30 * 7);
  near(m.installsPerWeek, 260000 / 30 * 7);
  // 620k + 10 wks × (44,333 − 60,667) = 456,667
  near(m.projectedAtTarget, 620000 + 10 * (190000 - 260000) / 30 * 7);
  near(m.cushion, m.projectedAtTarget - 350000);
  assert.equal(m.status, "safe");
  // room = 620k + 443,333 − 350k = 713,333 → 71,333 / week
  near(m.installRoom, 620000 + 190000 / 30 * 70 - 350000);
  near(m.allowancePerWeek, m.installRoom / 10);
  assert.equal(m.outpaceGap, 70000);
  near(m.outpacePct, 70000 / 190000, 1e-9);
  near(m.ratio, 190000 / 260000, 1e-9);
  near(m.roomLeftToBook, m.installRoom - 410000);
  assert.equal(m.backlog30DaysAgo, 690000);
  assert.equal(m.backlogChange30, -70000);
  assert.equal(m.projection[0].date, "2026-11-23");
  assert.equal(m.projection.at(-1).date, "2027-02-01");
  assert.equal(m.crossesRedline, null);
});

test("below the redline: crossing week and required cuts", () => {
  const m = redlineMath(parseRedlineSnapshot({ ...example, backlog: 450000, last30: { ...example.last30, backlogAtStart: null } }));
  assert.equal(m.status, "below");
  assert.ok(m.crossesRedline > "2026-11-23" && m.crossesRedline <= "2027-02-01");
  near(m.installCutPerWeek, m.installsPerWeek - m.allowancePerWeek);
  // At the needed sales pace the projection lands exactly on the redline.
  near(450000 + (m.salesNeededPerWeek - m.installsPerWeek) * m.weeksLeft, 350000);
  // backlogAtStart missing → falls back to the Monday nearest the window start.
  assert.equal(m.backlog30DaysAgo, 690000);
});

test("rejects bad input instead of guessing", () => {
  assert.throws(() => parseRedlineSnapshot({ ...example, snapshotDate: "2026-11-31" }), /snapshotDate/);
  assert.throws(() => parseRedlineSnapshot({ ...example, backlog: -1 }), /backlog/);
  assert.throws(() => parseRedlineSnapshot({ ...example, backlog: undefined }), /backlog is required/);
  assert.throws(() => parseRedlineSnapshot({ ...example, targetDate: "2026-11-01" }), /targetDate/);
  assert.throws(() => parseRedlineSnapshot({ ...example, last30: { ...example.last30, end: "2026-11-30" } }), /after the snapshot/);
  assert.throws(() => parseRedlineSnapshot({ ...example, kind: "other" }), /owner-redline/);
});

test("Monday Slack update uses Steven's format", () => {
  const text = mondaySlackUpdate(parseRedlineSnapshot(example));
  assert.match(text, /^📅 \*Feb 1 Redline Update – Mon Nov 23\*/);
  assert.match(text, /⚠ Installs out-paced sales by \$70,000 \(37%\)/);
  assert.match(text, /Install allowance: \$71,333\/week/);
  assert.match(text, /NorCal: sold \$60,000, installed \$110,000/);
  assert.match(text, /plus \$225,000 on Hold, not counted/);
  assert.match(text, /MidCal: sold \$30,000, installed \$35,000 · 4 wk out/);
});

test("Slack update leaves out room-left-to-book unless already over", () => {
  const ok = mondaySlackUpdate(parseRedlineSnapshot(example));
  assert.doesNotMatch(ok, /Room left to book/);
  const over = mondaySlackUpdate(parseRedlineSnapshot({ ...example, scheduledThroughTarget: 900000 }));
  assert.match(over, /⚠ Already booked \$186,667 more install work before Feb 1 than the allowance/);
});

test("goal typed on the dashboard is checked", () => {
  assert.deepEqual(parseRedlineGoal({ redline: "$400,000", targetDate: "2027-05-01" }, "2026-11-23"), { redline: 400000, targetDate: "2027-05-01" });
  assert.deepEqual(parseRedlineGoal({ redline: 350000.4, targetDate: "2026-11-24" }, "2026-11-23"), { redline: 350000, targetDate: "2026-11-24" });
  assert.throws(() => parseRedlineGoal({ redline: 400000, targetDate: "2026-11-23" }, "2026-11-23"), /after today/);
  assert.throws(() => parseRedlineGoal({ redline: 400000, targetDate: "2029-01-01" }, "2026-11-23"), /two years/);
  assert.throws(() => parseRedlineGoal({ redline: "abc", targetDate: "2027-05-01" }, "2026-11-23"), /redline/);
  assert.throws(() => parseRedlineGoal({ redline: 400000, targetDate: "2027-02-30" }, "2026-11-23"), /goal date/);
});
