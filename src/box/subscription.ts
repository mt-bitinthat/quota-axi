import type { ProviderSubscription } from "../types.js";
import type { BoxSubscriptionEntry } from "./config.js";

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
      : nextMonth(year, month, entry.renewsDay);

  const daysUntil = Math.round(
    (Date.UTC(renewal.year, renewal.month, renewal.day) -
      Date.UTC(year, month, today)) /
      86_400_000,
  );
  return {
    renewsAt: isoDate(renewal),
    amountAud: entry.amountAud,
    daysUntil,
  };
}

type CalendarDay = { year: number; month: number; day: number };

function nextMonth(
  year: number,
  month: number,
  renewsDay: number,
): CalendarDay {
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonthIndex = month === 11 ? 0 : month + 1;
  return {
    year: nextYear,
    month: nextMonthIndex,
    day: clampDayOfMonth(nextYear, nextMonthIndex, renewsDay),
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
