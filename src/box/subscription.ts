import type { ProviderSubscription } from "../types.js";
import { DEFAULT_WARN_DAYS, type BoxSubscriptionEntry } from "./config.js";

/**
 * Next subscription renewal in the operator's local time.
 *
 * The renewal is a calendar fact, not an instant: it is the next occurrence of
 * the billing day on or after today, so the day the subscription renews counts
 * as `0d` rather than as a day already gone. The countdown is measured between
 * two calendar days rather than between two clock times, which keeps it whole
 * across a daylight-saving boundary that would otherwise make a day 23 or 25
 * hours long.
 */
export function nextRenewal(
  entry: BoxSubscriptionEntry,
  now: Date,
  warnDays: number = DEFAULT_WARN_DAYS,
): ProviderSubscription | undefined {
  const time = now.getTime();
  if (!Number.isFinite(time)) return undefined;
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();

  const thisMonth = clampDayOfMonth(year, month, entry.renewsDay);
  const renewal =
    thisMonth >= today
      ? { year, month, day: thisMonth }
      : shiftMonth(year, month, 1, entry.renewsDay);

  return {
    renewsAt: isoDate(renewal),
    amountAud: entry.amountAud,
    daysUntil: daysBetween({ year, month, day: today }, renewal),
    warnDays,
  };
}

type CalendarDay = { year: number; month: number; day: number };

/** The same billing day one month either side of this one, clamped there too. */
function shiftMonth(
  year: number,
  month: number,
  delta: -1 | 1,
  renewsDay: number,
): CalendarDay {
  const shifted = new Date(year, month + delta, 1);
  const shiftedYear = shifted.getFullYear();
  const shiftedMonth = shifted.getMonth();
  return {
    year: shiftedYear,
    month: shiftedMonth,
    day: clampDayOfMonth(shiftedYear, shiftedMonth, renewsDay),
  };
}

/** A billing day of 31 lands on the 30th of a 30-day month, and so on. */
function clampDayOfMonth(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function isoDate({ year, month, day }: CalendarDay): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month + 1)}-${pad(day)}`;
}

/**
 * Box-dashboard fork: the billing cycle a spend window is measured over - the
 * stretch from the most recent renewal through today.
 */
export type SpendCycle = {
  /** ISO calendar date (YYYY-MM-DD) the window starts on, inclusive. */
  since: string;
  /** Days from `since` to today inclusive; the renewal day itself is `1`. */
  windowDays: number;
};

/**
 * The cycle the subscription is currently inside: the most recent occurrence of
 * the billing day on or before today, through today.
 *
 * It is the mirror of `nextRenewal` and reads the calendar the same way, with
 * the same month-end clamp, so a spend figure covers exactly what this billing
 * period has drawn. The renewal day itself is `1d` rather than an empty window:
 * the day a cycle opens is a day of that cycle.
 */
export function lastRenewal(
  entry: BoxSubscriptionEntry,
  now: Date,
): SpendCycle | undefined {
  const time = now.getTime();
  if (!Number.isFinite(time)) return undefined;
  const year = now.getFullYear();
  const month = now.getMonth();
  const today = now.getDate();

  const thisMonth = clampDayOfMonth(year, month, entry.renewsDay);
  const renewal =
    thisMonth <= today
      ? { year, month, day: thisMonth }
      : shiftMonth(year, month, -1, entry.renewsDay);
  return {
    since: isoDate(renewal),
    windowDays: daysBetween(renewal, { year, month, day: today }) + 1,
  };
}

/**
 * The rolling window a provider with no configured subscription falls back to,
 * so a card without a billing cycle still shows a figure. Counted inclusively,
 * as the cycle window is: a 30-day window ending today starts 29 days back.
 */
export function rollingCycle(now: Date, windowDays: number): SpendCycle {
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - (windowDays - 1),
  );
  return {
    since: isoDate({
      year: start.getFullYear(),
      month: start.getMonth(),
      day: start.getDate(),
    }),
    windowDays,
  };
}

/**
 * Whole calendar days between two local days. Measured on the UTC projection of
 * each calendar day, so a daylight-saving transition inside the interval cannot
 * make it read as a fraction of a day more or less.
 */
function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round(
    (Date.UTC(to.year, to.month, to.day) -
      Date.UTC(from.year, from.month, from.day)) /
      86_400_000,
  );
}
