import { describe, expect, it } from "vitest";
import { nextRenewal } from "../../src/box/subscription.js";

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
