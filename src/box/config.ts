import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFile } from "../lib/fs.js";

/**
 * Box-local dashboard configuration for this fork: the subscription each
 * provider is actually billed for, and the AUD rate every money figure on the
 * dashboard is shown in.
 *
 * It is operator-supplied presentation data. It never reaches a provider, never
 * holds a credential, and is never an input to a quota reading, so every
 * malformed part is dropped in silence: a broken `box.json` costs a line on a
 * card, never a provider reading and never a diagnostic on stdout.
 */

export type BoxFx = {
  /** AUD per 1 USD. */
  audPerUsd: number;
  /** ISO calendar date the rate was taken on, when the file records one. */
  asOf?: string;
};

export type BoxSubscriptionEntry = {
  /** Day of the month the subscription renews, 1-31, clamped in short months. */
  renewsDay: number;
  amountAud: number;
};

/**
 * Box-dashboard fork: how the Jev card prices the tokens it counts.
 *
 * TypeSafe publishes no rate card, so this is one operator-supplied number
 * rather than a per-model table: USD per million tokens, applied to input and
 * output alike. Without it the card counts calls and tokens and shows no money
 * at all, which is a truer answer than a rate nobody published.
 */
export type BoxJev = {
  /** USD per 1,000,000 tokens. */
  usdPerMTok: number;
};

export type BoxConfig = {
  fx?: BoxFx;
  /** Days before renewal at which the countdown turns red; default 3. */
  warnDays?: number;
  /** Keyed by provider id; unknown keys are kept and simply never matched. */
  subscriptions: Record<string, BoxSubscriptionEntry>;
  jev?: BoxJev;
};

export const DEFAULT_WARN_DAYS = 3;

export function boxConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "quota-axi", "box.json");
}

/**
 * Read the box configuration, or resolve undefined when there is nothing
 * usable in it. A missing file, unreadable file, unparseable JSON, and a file
 * whose every entry is malformed are deliberately the same answer: the
 * dashboard has no box facts to show.
 */
export function readBoxConfig(path = boxConfigPath()): BoxConfig | undefined {
  const value = readJsonFile(path);
  if (!isRecord(value)) return undefined;
  const fx = parseFx(value.fx);
  const warnDays = parseWarnDays(value.warnDays);
  const subscriptions = parseSubscriptions(value.subscriptions);
  const jev = parseJev(value.jev);
  if (
    fx === undefined &&
    jev === undefined &&
    Object.keys(subscriptions).length === 0
  ) {
    return undefined;
  }
  return {
    ...(fx ? { fx } : {}),
    ...(warnDays === undefined ? {} : { warnDays }),
    subscriptions,
    ...(jev ? { jev } : {}),
  };
}

function parseFx(value: unknown): BoxFx | undefined {
  if (!isRecord(value)) return undefined;
  const audPerUsd = positiveNumber(value.audPerUsd);
  if (audPerUsd === undefined) return undefined;
  const asOf = typeof value.asOf === "string" ? value.asOf.trim() : "";
  return { audPerUsd, ...(asOf === "" ? {} : { asOf }) };
}

/**
 * The Jev rate, or nothing. A rate of zero, a negative rate, and a rate that is
 * not a number are all the same answer as an absent one: the card shows token
 * counts and no money, rather than pricing every call at nothing.
 */
function parseJev(value: unknown): BoxJev | undefined {
  if (!isRecord(value)) return undefined;
  const usdPerMTok = positiveNumber(value.usdPerMTok);
  if (usdPerMTok === undefined) return undefined;
  return { usdPerMTok };
}

/** A whole number of days, zero or more; anything else falls back to the default. */
function parseWarnDays(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseSubscriptions(
  value: unknown,
): Record<string, BoxSubscriptionEntry> {
  if (!isRecord(value)) return {};
  const entries: Record<string, BoxSubscriptionEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    const entry = parseSubscriptionEntry(raw);
    if (entry) entries[key] = entry;
  }
  return entries;
}

function parseSubscriptionEntry(
  value: unknown,
): BoxSubscriptionEntry | undefined {
  if (!isRecord(value)) return undefined;
  const renewsDay = value.renewsDay;
  const amountAud = value.amountAud;
  if (
    typeof renewsDay !== "number" ||
    !Number.isInteger(renewsDay) ||
    renewsDay < 1 ||
    renewsDay > 31
  ) {
    return undefined;
  }
  if (
    typeof amountAud !== "number" ||
    !Number.isFinite(amountAud) ||
    amountAud < 0
  ) {
    return undefined;
  }
  return { renewsDay, amountAud };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
