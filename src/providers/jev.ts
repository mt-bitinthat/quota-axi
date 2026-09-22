import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readBoxConfig, type BoxConfig } from "../box/config.js";
import {
  calendarMonthCycle,
  lastRenewal,
  type SpendCycle,
} from "../box/subscription.js";
import type {
  AuthProviderReport,
  JevUsage,
  ProviderAdapter,
  ProviderJev,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

/**
 * Box-dashboard fork: what this box has asked TypeSafe's Jev for, counted from
 * the local call ledger.
 *
 * TypeSafe publishes no usage, credit or billing endpoint - `/v1/usage`,
 * `/account`, `/credits`, `/me` and `/billing` all answer 404, and no rate or
 * credit headers come back on a real call - so there is no vendor figure to
 * read. What there is instead is a ledger every Jev-calling tool on this box
 * appends one line to per API request, and that is what this card counts. Like
 * the `aws` card it is local, credential-free arithmetic: no request leaves the
 * box to render it.
 *
 * It counts calls made, not allowance left. Nothing here bounds anything: there
 * is no published cap behind these tokens to run out of, and a rate the
 * operator configures prices what was spent rather than metering what remains.
 */

const LABEL = "Jev";
export const JEV_LEDGER_SOURCE = "ledger";

/** A ledger with no usable line in it, and a ledger that is not there. */
const NO_LEDGER = "no ledger";

/** `2026-09-22T07:08:38+0000`: the ledger's own basic-offset spelling. */
const BASIC_OFFSET = /([+-]\d{2})(\d{2})$/;

type LedgerEntry = {
  /** The entry's own timestamp, as the ledger spelled it. */
  ts: string;
  atMs: number;
  inputTokens: number;
  outputTokens: number;
};

type Dependencies = {
  ledgerPath: () => string;
  readConfig: () => BoxConfig | undefined;
  now: () => number;
};

export function jevLedgerPath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "jev", "ledger.jsonl");
}

export function createJevAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    ledgerPath: jevLedgerPath,
    readConfig: () => readBoxConfig(),
    now: Date.now,
    ...overrides,
  };
  return {
    id: "jev",
    label: LABEL,
    fetchQuota: async () => fetchQuota(dependencies),
    inspectAuth: async () => inspectAuth(),
  };
}

export const jevAdapter = createJevAdapter();

function fetchQuota(dependencies: Dependencies): ProviderQuota {
  const entries = readLedger(dependencies.ledgerPath());
  if (entries.length === 0) {
    return failedProvider({
      provider: "jev",
      label: LABEL,
      status: "unavailable",
      error: NO_LEDGER,
      source: "unavailable",
      sourcesTried: [JEV_LEDGER_SOURCE],
      attempts: [
        { source: JEV_LEDGER_SOURCE, status: "failed", error: NO_LEDGER },
      ],
    });
  }

  const nowMs = dependencies.now();
  const now = new Date(nowMs);
  const config = dependencies.readConfig();
  const cycle = spendCycle(config, now);
  const usdPerMTok = config?.jev?.usdPerMTok;
  const today = localDate(now);

  const jev: ProviderJev = {
    today: total(
      entries.filter((entry) => localDate(new Date(entry.atMs)) === today),
      usdPerMTok,
    ),
    cycle: total(
      entries.filter((entry) => localDate(new Date(entry.atMs)) >= cycle.since),
      usdPerMTok,
    ),
    allTime: total(entries, usdPerMTok),
    cycleSince: cycle.since,
    cycleWindowDays: cycle.windowDays,
    lastCallAt: latest(entries).ts,
    ...(usdPerMTok === undefined ? {} : { usdPerMTok }),
  };

  const attempts: SourceAttempt[] = [
    { source: JEV_LEDGER_SOURCE, status: "success" },
  ];
  return successProvider({
    provider: "jev",
    label: LABEL,
    source: JEV_LEDGER_SOURCE,
    // Calls already made are not a quota window and bound nothing: no published
    // allowance stands behind them.
    windows: [],
    jev,
    refreshedAt: new Date(nowMs).toISOString(),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

/** No credential reaches this provider, so there is no auth source to inspect. */
async function inspectAuth(): Promise<AuthProviderReport> {
  return { provider: "jev", sources: [] };
}

/**
 * The window the cycle figure covers: the billing cycle this box's `box.json`
 * puts Jev in, or the calendar month when it names no billing day. A card
 * always has a cycle, so a missing entry costs the figure its billing anchor,
 * never the line.
 */
function spendCycle(config: BoxConfig | undefined, now: Date): SpendCycle {
  const entry = config?.subscriptions.jev;
  return (entry && lastRenewal(entry, now)) ?? calendarMonthCycle(now);
}

/**
 * Every usable line of the ledger, oldest-first order preserved.
 *
 * A line that is not an object with a readable timestamp and two token counts
 * is skipped in silence: the ledger is appended to by several tools at once, so
 * a torn or half-written final line is an ordinary thing to find there, and one
 * unreadable line must not cost the card every line that did parse. A ledger
 * that cannot be opened at all resolves the same way as an empty one - there is
 * nothing to count either way.
 */
function readLedger(path: string): LedgerEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseEntry(line: string): LedgerEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const ts = typeof value.ts === "string" ? value.ts.trim() : "";
  const atMs = parseTimestamp(ts);
  if (atMs === undefined) return undefined;
  const inputTokens = tokenCount(value.input_tokens);
  const outputTokens = tokenCount(value.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return { ts, atMs, inputTokens, outputTokens };
}

/**
 * The ledger writes its offset as `+0000` rather than `+00:00`. That is a valid
 * ISO 8601 spelling but not one the ECMAScript date grammar covers, so it is
 * normalised before parsing rather than left to an engine's own fallback.
 */
function parseTimestamp(ts: string): number | undefined {
  if (ts === "") return undefined;
  const parsed = Date.parse(ts.replace(BASIC_OFFSET, "$1:$2"));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function total(
  entries: readonly LedgerEntry[],
  usdPerMTok: number | undefined,
): JevUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const entry of entries) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
  }
  const tokens = inputTokens + outputTokens;
  return {
    calls: entries.length,
    inputTokens,
    outputTokens,
    tokens,
    ...(usdPerMTok === undefined
      ? {}
      : { usd: round4((tokens / 1e6) * usdPerMTok) }),
  };
}

/**
 * The newest entry by its own timestamp rather than by file order: the ledger
 * is appended to concurrently, so the last line is not reliably the last call.
 */
function latest(entries: readonly LedgerEntry[]): LedgerEntry {
  return entries.reduce((newest, entry) =>
    entry.atMs > newest.atMs ? entry : newest,
  );
}

/** The local calendar date an instant falls on, as `YYYY-MM-DD`. */
function localDate(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(at.getFullYear()).padStart(4, "0")}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
