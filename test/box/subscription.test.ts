import { describe, expect, it } from "vitest";
import {
  calendarMonthCycle,
  lastRenewal,
  nextRenewal,
  rollingCycle,
} from "../../src/box/subscription.js";

const CLAUDE = { renewsDay: 5, amountAud: 305 };

/** Local midnight, so the renewal maths is read in the operator's own day. */
function local(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour);
}

describe("nextRenewal", () => {
  it("carries the configured warning threshold", () => {
    expect(nextRenewal(CLAUDE, local(2026, 9, 22), 7)?.warnDays).toBe(7);
  });

  it("counts to the next occurrence later in the same month", () => {
    expect(nextRenewal(CLAUDE, local(2026, 9, 22))).toEqual({
      renewsAt: "2026-10-05",
      amountAud: 305,
      daysUntil: 13,
      warnDays: 3,
    });
  });

  it("rolls into the next month once the day has passed", () => {
    expect(nextRenewal(CLAUDE, local(2026, 9, 6))).toEqual({
      renewsAt: "2026-10-05",
      amountAud: 305,
      daysUntil: 29,
      warnDays: 3,
    });
  });

  it("rolls across a year boundary", () => {
    expect(nextRenewal(CLAUDE, local(2026, 12, 20))).toEqual({
      renewsAt: "2027-01-05",
      amountAud: 305,
      daysUntil: 16,
      warnDays: 3,
    });
  });

  it("counts the renewal day itself as zero, not as a month away", () => {
    expect(nextRenewal(CLAUDE, local(2026, 10, 5))).toEqual({
      renewsAt: "2026-10-05",
      amountAud: 305,
      daysUntil: 0,
      warnDays: 3,
    });
  });

  it("clamps a 31st billing day to the last day of a 30-day month", () => {
    expect(
      nextRenewal({ renewsDay: 31, amountAud: 20 }, local(2026, 9, 15)),
    ).toEqual({
      renewsAt: "2026-09-30",
      amountAud: 20,
      daysUntil: 15,
      warnDays: 3,
    });
  });

  it("clamps into February and still rolls forward when that day has passed", () => {
    expect(
      nextRenewal({ renewsDay: 31, amountAud: 20 }, local(2027, 1, 31)),
    ).toEqual({
      renewsAt: "2027-01-31",
      amountAud: 20,
      daysUntil: 0,
      warnDays: 3,
    });
    expect(
      nextRenewal({ renewsDay: 31, amountAud: 20 }, local(2027, 2, 1)),
    ).toEqual({
      renewsAt: "2027-02-28",
      amountAud: 20,
      daysUntil: 27,
      warnDays: 3,
    });
  });

  it("keeps a leap-February clamp on the 29th", () => {
    expect(
      nextRenewal({ renewsDay: 30, amountAud: 20 }, local(2028, 2, 3)),
    ).toEqual({
      renewsAt: "2028-02-29",
      amountAud: 20,
      daysUntil: 26,
      warnDays: 3,
    });
  });

  it("stays whole across a daylight-saving transition", () => {
    // Sydney springs forward on 2026-10-04, so the interval holding the change
    // is 23 hours rather than 24. The countdown is calendar days, not clock
    // time, so the day either side of it still reads as one whole day.
    const previous = process.env.TZ;
    process.env.TZ = "Australia/Sydney";
    try {
      expect(nextRenewal(CLAUDE, local(2026, 10, 3))).toEqual({
        renewsAt: "2026-10-05",
        amountAud: 305,
        daysUntil: 2,
        warnDays: 3,
      });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("resolves undefined for an unusable clock", () => {
    expect(nextRenewal(CLAUDE, new Date(Number.NaN))).toBeUndefined();
  });
});

describe("lastRenewal", () => {
  it("counts the renewal day itself as the first day of the cycle", () => {
    expect(lastRenewal(CLAUDE, local(2026, 10, 5))).toEqual({
      since: "2026-10-05",
      windowDays: 1,
    });
  });

  it("counts the day after the renewal as the second", () => {
    expect(lastRenewal(CLAUDE, local(2026, 10, 6))).toEqual({
      since: "2026-10-05",
      windowDays: 2,
    });
  });

  it("reaches back into last month once this month's day is still ahead", () => {
    expect(lastRenewal(CLAUDE, local(2026, 10, 3))).toEqual({
      since: "2026-09-05",
      windowDays: 29,
    });
  });

  it("counts a cycle already open earlier this month", () => {
    expect(lastRenewal(CLAUDE, local(2026, 9, 22))).toEqual({
      since: "2026-09-05",
      windowDays: 18,
    });
  });

  it("reaches back across a year boundary", () => {
    expect(lastRenewal(CLAUDE, local(2027, 1, 2))).toEqual({
      since: "2026-12-05",
      windowDays: 29,
    });
  });

  it("clamps a 31st billing day to the last day of the month it fell in", () => {
    // September has no 31st, so the cycle open on the 15th started on 31 Aug.
    expect(
      lastRenewal({ renewsDay: 31, amountAud: 20 }, local(2026, 9, 15)),
    ).toEqual({ since: "2026-08-31", windowDays: 16 });
    // Once the clamped day has arrived, that clamped day opens the cycle.
    expect(
      lastRenewal({ renewsDay: 31, amountAud: 20 }, local(2026, 9, 30)),
    ).toEqual({ since: "2026-09-30", windowDays: 1 });
  });

  it("clamps into February", () => {
    expect(
      lastRenewal({ renewsDay: 31, amountAud: 20 }, local(2027, 3, 2)),
    ).toEqual({ since: "2027-02-28", windowDays: 3 });
    expect(
      lastRenewal({ renewsDay: 30, amountAud: 20 }, local(2028, 3, 1)),
    ).toEqual({ since: "2028-02-29", windowDays: 2 });
  });

  it("stays whole across a daylight-saving transition", () => {
    // Sydney springs forward on 2026-10-04: the interval holding the change is
    // 23 hours, and the cycle is still counted in whole calendar days.
    const previous = process.env.TZ;
    process.env.TZ = "Australia/Sydney";
    try {
      expect(lastRenewal(CLAUDE, local(2026, 10, 6))).toEqual({
        since: "2026-10-05",
        windowDays: 2,
      });
      expect(lastRenewal(CLAUDE, local(2026, 10, 3))).toEqual({
        since: "2026-09-05",
        windowDays: 29,
      });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("resolves undefined for an unusable clock", () => {
    expect(lastRenewal(CLAUDE, new Date(Number.NaN))).toBeUndefined();
  });
});

describe("rollingCycle", () => {
  it("counts the fallback window inclusively of today", () => {
    expect(rollingCycle(local(2026, 9, 22), 30)).toEqual({
      since: "2026-08-24",
      windowDays: 30,
    });
    expect(rollingCycle(local(2026, 1, 1), 30)).toEqual({
      since: "2025-12-03",
      windowDays: 30,
    });
  });
});

describe("calendarMonthCycle", () => {
  it("opens on the first of this month and counts through today", () => {
    expect(calendarMonthCycle(local(2026, 9, 22))).toEqual({
      since: "2026-09-01",
      windowDays: 22,
    });
  });

  it("counts the first of the month as a one-day window", () => {
    expect(calendarMonthCycle(local(2026, 9, 1))).toEqual({
      since: "2026-09-01",
      windowDays: 1,
    });
  });

  it("restarts on the first of a new year", () => {
    expect(calendarMonthCycle(local(2027, 1, 3))).toEqual({
      since: "2027-01-01",
      windowDays: 3,
    });
  });
});
