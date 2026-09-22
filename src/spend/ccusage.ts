import { writeFileSync } from "node:fs";
import { ccusageCacheFilePath, ensurePrivateParent, readJsonFile } from "../lib/fs.js";
import { execFileText, findCommandPath } from "../lib/process.js";

/**
 * Box-dashboard fork: API-equivalent spend over a trailing window, read from
 * ccusage (https://github.com/ccusage/ccusage).
 *
 * ccusage reads this machine's own agent transcripts and prices them against
 * the LiteLLM model price table it embeds at build time. That makes the figure
 * an equivalence - what the same traffic would have cost at published API list
 * prices - and never a bill, never a quota reading, and never anything a
 * provider was asked for.
 *
 * The subprocess is the slow part of the dashboard, so it is never on the
 * render path: `primeCcusage` starts it alongside the provider fetches,
 * `peekCcusage` reports whatever has landed by the time they finish, and the
 * summary is cached for ten minutes so a repeating dashboard spawns nothing at
 * all on most refreshes.
 */

export const SPEND_WINDOW_DAYS = 30;

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_VERSION = 1;
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

export type SpendReading = {
  buckets: SpendBuckets;
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
  windowDays: number;
  since: string;
  /** Total USD per model name over the window, as ccusage priced it. */
  models: Record<string, number>;
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
 * Start resolving the window without waiting for it. A fresh cache satisfies
 * this synchronously; otherwise one refresh runs, and a second call while it is
 * in flight joins the first rather than spawning again.
 */
export function primeCcusage(deps: SpendDeps = {}): void {
  if (state.reading || state.inFlight) return;
  const now = (deps.now ?? Date.now)();
  const cached = readCcusageCache(now, deps.cachePath);
  if (cached) {
    state.reading = cached;
    state.unavailable = false;
    return;
  }
  state.inFlight = refresh(deps).finally(() => {
    state.inFlight = undefined;
  });
}

/** Whatever has landed so far. Never waits and never spawns on its own. */
export function peekCcusage(deps: SpendDeps = {}): SpendResult {
  primeCcusage(deps);
  if (state.reading) return { status: "measured", reading: state.reading };
  return state.unavailable ? { status: "unavailable" } : { status: "pending" };
}

/** Wait for the window to resolve. Used by the one-shot machine surfaces. */
export async function resolveCcusage(
  deps: SpendDeps = {},
): Promise<SpendResult> {
  primeCcusage(deps);
  await state.inFlight;
  return peekCcusage(deps);
}

async function refresh(deps: SpendDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const since = ccusageSince(now);
  try {
    const output = await (deps.run ?? runCcusage)(since);
    const models = ccusageModelCosts(JSON.parse(output) as unknown);
    if (models === undefined) {
      state.unavailable = true;
      return;
    }
    const refreshedAt = new Date(now).toISOString();
    state.reading = { buckets: bucketModelCosts(models), refreshedAt };
    state.unavailable = false;
    writeCcusageCache(
      { version: CACHE_VERSION, refreshedAt, windowDays: SPEND_WINDOW_DAYS, since, models },
      deps.cachePath,
    );
  } catch {
    // A missing binary, a timeout, and unparseable output are the same answer
    // to the dashboard: no figure this cycle. Nothing is logged - the card
    // already says the line is unavailable.
    state.unavailable = true;
  }
}

/** `--since` stamp for a window of `SPEND_WINDOW_DAYS` calendar days ending today. */
export function ccusageSince(now: number): string {
  const date = new Date(now);
  const start = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - (SPEND_WINDOW_DAYS - 1),
  );
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
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
 * Total USD per model over the whole window. ccusage reports its own
 * `totals.totalCost` alongside these rows; summing the per-model breakdowns
 * reproduces it exactly, which is what lets the two dashboard buckets be
 * checked against the tool's own figure.
 */
export function ccusageModelCosts(
  payload: unknown,
): Record<string, number> | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.daily)) return undefined;
  const costs: Record<string, number> = {};
  for (const day of payload.daily) {
    if (!isRecord(day) || !Array.isArray(day.modelBreakdowns)) continue;
    for (const entry of day.modelBreakdowns) {
      if (!isRecord(entry)) continue;
      const { modelName, cost } = entry;
      if (typeof modelName !== "string" || modelName === "") continue;
      if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
      costs[modelName] = (costs[modelName] ?? 0) + cost;
    }
  }
  return costs;
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

export function readCcusageCache(
  now: number,
  path = ccusageCacheFilePath(),
): SpendReading | undefined {
  const value = readJsonFile(path);
  if (!isRecord(value)) return undefined;
  const { version, refreshedAt, windowDays, models } = value;
  if (version !== CACHE_VERSION) return undefined;
  if (windowDays !== SPEND_WINDOW_DAYS) return undefined;
  if (typeof refreshedAt !== "string") return undefined;
  const stamped = Date.parse(refreshedAt);
  if (!Number.isFinite(stamped)) return undefined;
  if (now - stamped >= CACHE_TTL_MS || now < stamped) return undefined;
  if (!isRecord(models)) return undefined;
  const costs: Record<string, number> = {};
  for (const [model, cost] of Object.entries(models)) {
    if (typeof cost === "number" && Number.isFinite(cost)) costs[model] = cost;
  }
  return { buckets: bucketModelCosts(costs), refreshedAt };
}

function writeCcusageCache(file: SpendCacheFile, path?: string): void {
  const target = path ?? ccusageCacheFilePath();
  try {
    ensurePrivateParent(target);
    writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // A cache that cannot be written only costs the next run a respawn.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
