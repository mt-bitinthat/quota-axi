import { chmodSync, renameSync, writeFileSync } from "node:fs";
import {
  ccusageCacheFilePath,
  ensurePrivateParent,
  readJsonFile,
} from "../lib/fs.js";
import { execFileText, findCommandPath } from "../lib/process.js";

/**
 * Box-dashboard fork: API-equivalent spend over a window, read from ccusage
 * (https://github.com/ccusage/ccusage).
 *
 * ccusage reads this machine's own agent transcripts and prices them against
 * the LiteLLM model price table it embeds at build time. That makes the figure
 * an equivalence - what the same traffic would have cost at published API list
 * prices - and never a bill, never a quota reading, and never anything a
 * provider was asked for.
 *
 * One run covers every card. Each card owns a different window - its own
 * billing cycle - so the run asks for the earliest start any of them needs and
 * keeps the answer as priced days, which each window is then a filter over.
 * That way a cycle rolling over, or a second card billed on another day of the
 * month, costs no second subprocess.
 *
 * The subprocess is the slow part of the dashboard, so it is never on the
 * render path: `primeCcusage` starts it alongside the provider fetches,
 * `peekCcusage` reports whatever has landed by the time they finish, and the
 * priced days are cached for ten minutes so a repeating dashboard spawns
 * nothing at all on most refreshes.
 */

/** The rolling window a card with no configured billing cycle falls back to. */
export const SPEND_WINDOW_DAYS = 30;

const CACHE_TTL_MS = 10 * 60 * 1000;
/** 2: per-day per-model costs, replacing a single summed window summary. */
const CACHE_VERSION = 2;
const RUN_TIMEOUT_MS = 90_000;
/** ccusage emits one row per model per day; a month of them is small. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Path to the ccusage executable, or `off` to disable the subprocess entirely.
 * Tests set `off` so no suite can spawn a vendor CLI by accident.
 */
const EXECUTABLE_ENV = "QUOTA_AXI_CCUSAGE";

export type SpendBuckets = {
  claudeUsd: number;
  otherUsd: number;
  totalUsd: number;
};

/** One priced calendar day, keyed by the model name ccusage reported. */
export type SpendDay = {
  /** ISO calendar date (YYYY-MM-DD), as ccusage dates its own rows. */
  date: string;
  models: Record<string, number>;
};

export type SpendReading = {
  days: SpendDay[];
  /** ISO calendar date the run covers from; every window must start at or after it. */
  since: string;
  refreshedAt: string;
};

export type SpendResult =
  | { status: "measured"; reading: SpendReading }
  | { status: "pending" }
  | { status: "unavailable" };

export type SpendDeps = {
  now?: () => number;
  cachePath?: string;
  /** Resolves ccusage's raw `daily --json` stdout for the given `--since`. */
  run?: (since: string) => Promise<string>;
};

type SpendCacheFile = {
  version: number;
  refreshedAt: string;
  since: string;
  days: SpendDay[];
};

type SpendState = {
  reading?: SpendReading;
  unavailable: boolean;
  inFlight?: Promise<void>;
};

const state: SpendState = { unavailable: false };

/** Drop every in-process memo. Tests call this between cases. */
export function resetCcusageState(): void {
  state.reading = undefined;
  state.unavailable = false;
  state.inFlight = undefined;
}

/**
 * Start resolving the days from `since` without waiting for them. A fresh cache
 * satisfies this synchronously; otherwise one refresh runs, and a second call
 * while it is in flight joins the first rather than spawning again.
 *
 * `since` is the earliest ISO calendar date any card's window needs. A reading
 * that already reaches further back covers every one of them.
 */
export function primeCcusage(since: string, deps: SpendDeps = {}): void {
  if (covers(state.reading, since) || state.inFlight) return;
  const now = (deps.now ?? Date.now)();
  const cached = readCcusageCache(now, since, deps.cachePath);
  if (cached) {
    state.reading = cached;
    state.unavailable = false;
    return;
  }
  state.inFlight = refresh(since, deps).finally(() => {
    state.inFlight = undefined;
  });
}

/** Whatever has landed so far. Never waits and never spawns on its own. */
export function peekCcusage(since: string, deps: SpendDeps = {}): SpendResult {
  primeCcusage(since, deps);
  if (state.reading && covers(state.reading, since)) {
    return { status: "measured", reading: state.reading };
  }
  return state.unavailable ? { status: "unavailable" } : { status: "pending" };
}

/** Wait for the days to resolve. Used by the one-shot machine surfaces. */
export async function resolveCcusage(
  since: string,
  deps: SpendDeps = {},
): Promise<SpendResult> {
  primeCcusage(since, deps);
  await state.inFlight;
  return peekCcusage(since, deps);
}

/** A reading serves a window only when it reaches back at least as far. */
function covers(reading: SpendReading | undefined, since: string): boolean {
  return reading !== undefined && reading.since <= since;
}

async function refresh(since: string, deps: SpendDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  try {
    const output = await (deps.run ?? runCcusage)(ccusageStamp(since));
    const days = ccusageDailyCosts(JSON.parse(output) as unknown);
    if (days === undefined) {
      state.unavailable = true;
      return;
    }
    const refreshedAt = new Date(now).toISOString();
    state.reading = { days, since, refreshedAt };
    state.unavailable = false;
    writeCcusageCache(
      { version: CACHE_VERSION, refreshedAt, since, days },
      deps.cachePath,
    );
  } catch {
    // A missing binary, a timeout, and unparseable output are the same answer
    // to the dashboard: no figure this cycle. Nothing is logged - the card
    // already says the line is unavailable.
    state.unavailable = true;
  }
}

/** ccusage's `--since` stamp for an ISO calendar date: `2026-09-05` is `20260905`. */
export function ccusageStamp(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

async function runCcusage(since: string): Promise<string> {
  const override = process.env[EXECUTABLE_ENV]?.trim();
  if (override === "off") throw new Error("ccusage_disabled");
  const args = ["daily", "--since", since, "--json"];
  const binary =
    override !== undefined && override !== ""
      ? override
      : await findCommandPath("ccusage");
  if (binary !== undefined) {
    return execFileText(binary, args, RUN_TIMEOUT_MS, MAX_OUTPUT_BYTES);
  }
  // No user-local install: fall back to the published package so the dashboard
  // still reports, paying npx's resolution latency for it.
  const npx = await findCommandPath("npx");
  if (npx === undefined) throw new Error("ccusage_unavailable");
  return execFileText(
    npx,
    ["-y", "ccusage@latest", ...args],
    RUN_TIMEOUT_MS,
    MAX_OUTPUT_BYTES,
  );
}

/**
 * USD per model per day, as ccusage priced it. Keeping the days apart is what
 * lets one run answer two cards whose billing cycles start on different dates.
 *
 * A row that carries no calendar date is dropped rather than counted: it cannot
 * be placed in any window, and a figure that silently borrows another cycle's
 * traffic would be worse than one that is short by a row ccusage did not date.
 */
export function ccusageDailyCosts(payload: unknown): SpendDay[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.daily)) return undefined;
  const days: SpendDay[] = [];
  for (const day of payload.daily) {
    if (!isRecord(day) || !Array.isArray(day.modelBreakdowns)) continue;
    const date = dayDate(day);
    if (date === undefined) continue;
    const models: Record<string, number> = {};
    for (const entry of day.modelBreakdowns) {
      if (!isRecord(entry)) continue;
      const { modelName, cost } = entry;
      if (typeof modelName !== "string" || modelName === "") continue;
      if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
      models[modelName] = (models[modelName] ?? 0) + cost;
    }
    days.push({ date, models });
  }
  return days;
}

/** ccusage names the day `period`; `date` is accepted as the same fact. */
function dayDate(day: Record<string, unknown>): string | undefined {
  for (const value of [day.period, day.date]) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Total USD per model from `since` onward. ccusage reports its own
 * `totals.totalCost` alongside these rows; summing the per-model breakdowns of
 * every day it returned reproduces it exactly, which is what lets the two
 * dashboard buckets be checked against the tool's own figure.
 */
export function modelCostsSince(
  days: readonly SpendDay[],
  since?: string,
): Record<string, number> {
  const costs: Record<string, number> = {};
  for (const day of days) {
    if (since !== undefined && day.date < since) continue;
    for (const [model, cost] of Object.entries(day.models)) {
      costs[model] = (costs[model] ?? 0) + cost;
    }
  }
  return costs;
}

/** The two card buckets over one card's own window. */
export function spendBucketsSince(
  reading: SpendReading,
  since: string,
): SpendBuckets {
  return bucketModelCosts(modelCostsSince(reading.days, since));
}

/**
 * Split priced models into the two cards this dashboard has: Claude's own
 * models, and everything else, which on this box is Codex and Pi traffic.
 */
export function bucketModelCosts(costs: Record<string, number>): SpendBuckets {
  let claudeUsd = 0;
  let otherUsd = 0;
  for (const [model, cost] of Object.entries(costs)) {
    if (isClaudeModel(model)) claudeUsd += cost;
    else otherUsd += cost;
  }
  return { claudeUsd, otherUsd, totalUsd: claudeUsd + otherUsd };
}

/**
 * ccusage prefixes a row with the harness that logged it ("[pi] gpt-6-astra"),
 * so the vendor is read after any bracketed prefix rather than off the front of
 * the raw string.
 */
function isClaudeModel(model: string): boolean {
  return model
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .toLowerCase()
    .startsWith("claude");
}

/**
 * The cached days, when they are fresh and reach back at least as far as this
 * read needs. A cache written by an earlier schema is ignored, not repaired:
 * the next refresh replaces it, and nothing but a dashboard line is at stake.
 */
export function readCcusageCache(
  now: number,
  since: string,
  path = ccusageCacheFilePath(),
): SpendReading | undefined {
  const value = readJsonFile(path);
  if (!isRecord(value)) return undefined;
  const { version, refreshedAt, since: cachedSince, days } = value;
  if (version !== CACHE_VERSION) return undefined;
  if (typeof cachedSince !== "string" || cachedSince > since) return undefined;
  if (typeof refreshedAt !== "string") return undefined;
  const stamped = Date.parse(refreshedAt);
  if (!Number.isFinite(stamped)) return undefined;
  if (now - stamped >= CACHE_TTL_MS || now < stamped) return undefined;
  const parsed = parseCachedDays(days);
  if (parsed === undefined) return undefined;
  return { days: parsed, since: cachedSince, refreshedAt };
}

function parseCachedDays(value: unknown): SpendDay[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const days: SpendDay[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { date, models } = entry;
    if (typeof date !== "string" || !isRecord(models)) continue;
    const costs: Record<string, number> = {};
    for (const [model, cost] of Object.entries(models)) {
      if (typeof cost === "number" && Number.isFinite(cost))
        costs[model] = cost;
    }
    days.push({ date, models: costs });
  }
  return days;
}

/**
 * Write through a temporary file, as the quota cache does: a refresh that is
 * still running when the process exits leaves no half-written summary behind,
 * and an existing file's mode is replaced rather than inherited.
 */
function writeCcusageCache(file: SpendCacheFile, path?: string): void {
  const target = path ?? ccusageCacheFilePath();
  const temp = `${target}.${process.pid}.tmp`;
  try {
    ensurePrivateParent(target);
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } catch {
    // A cache that cannot be written only costs the next run a respawn.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
