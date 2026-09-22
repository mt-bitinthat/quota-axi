import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bucketModelCosts,
  ccusageDailyCosts,
  ccusageStamp,
  modelCostsSince,
  peekCcusage,
  primeCcusage,
  readCcusageCache,
  resetCcusageState,
  resolveCcusage,
  spendBucketsSince,
  SPEND_WINDOW_DAYS,
  type SpendDay,
} from "../../src/spend/ccusage.js";
import { ccusageDailyFixture, ccusagePayload } from "../fixtures/ccusage.js";

const NOW = Date.UTC(2026, 8, 22, 3, 0, 0);
/** The window a card billed on the 5th is inside on 2026-09-22. */
const CYCLE_SINCE = "2026-09-05";

let directory: string;
let cachePath: string;

beforeEach(() => {
  resetCcusageState();
  directory = mkdtempSync(join(tmpdir(), "quota-axi-ccusage-"));
  cachePath = join(directory, "ccusage-daily.json");
});

afterEach(() => {
  resetCcusageState();
  rmSync(directory, { recursive: true, force: true });
});

function days(payload: unknown): SpendDay[] {
  const parsed = ccusageDailyCosts(payload);
  expect(parsed).toBeDefined();
  return parsed as SpendDay[];
}

describe("ccusage bucketing", () => {
  it("splits a real ccusage window into two buckets that sum to its own total", () => {
    const payload = ccusageDailyFixture() as {
      totals: { totalCost: number };
    };
    const buckets = bucketModelCosts(modelCostsSince(days(payload)));

    // ccusage's own figure for the same window, to the cent.
    expect(buckets.totalUsd).toBeCloseTo(payload.totals.totalCost, 2);
    expect(buckets.claudeUsd + buckets.otherUsd).toBeCloseTo(
      payload.totals.totalCost,
      2,
    );
    expect(buckets.claudeUsd).toBeCloseTo(1078.87, 2);
    expect(buckets.otherUsd).toBeCloseTo(17.44, 2);
  });

  it("reads the vendor after a harness prefix, so a Pi row is not Claude's", () => {
    const buckets = bucketModelCosts({
      "claude-opus-5": 10,
      "[pi] gpt-6-astra": 3,
      "gpt-5.6-sol": 2,
      "[pi] claude-sonnet-5": 5,
    });
    expect(buckets).toEqual({ claudeUsd: 15, otherUsd: 5, totalUsd: 20 });
  });

  it("ignores rows it cannot price rather than counting them as zero", () => {
    expect(
      ccusageDailyCosts({
        daily: [
          {
            period: "2026-09-21",
            modelBreakdowns: [
              { modelName: "claude-opus-5", cost: 4 },
              { modelName: "claude-opus-5", cost: "3" },
              { cost: 9 },
              { modelName: "gpt-6-astra" },
              null,
            ],
          },
          { period: "2026-09-22", modelBreakdowns: "none" },
        ],
      }),
    ).toEqual([{ date: "2026-09-21", models: { "claude-opus-5": 4 } }]);
  });

  it("drops a day it cannot date, rather than lending it to every window", () => {
    expect(
      ccusageDailyCosts({
        daily: [
          { modelBreakdowns: [{ modelName: "claude-opus-5", cost: 4 }] },
          {
            period: "not-a-date",
            modelBreakdowns: [{ modelName: "claude-opus-5", cost: 5 }],
          },
          {
            date: "2026-09-20",
            modelBreakdowns: [{ modelName: "claude-opus-5", cost: 6 }],
          },
        ],
      }),
    ).toEqual([{ date: "2026-09-20", models: { "claude-opus-5": 6 } }]);
  });

  it("resolves undefined for output that is not a ccusage report", () => {
    expect(ccusageDailyCosts({})).toBeUndefined();
    expect(ccusageDailyCosts([])).toBeUndefined();
    expect(ccusageDailyCosts("nope")).toBeUndefined();
  });

  it("stamps an ISO window start the way ccusage's --since wants it", () => {
    expect(ccusageStamp("2026-08-24")).toBe("20260824");
    expect(SPEND_WINDOW_DAYS).toBe(30);
  });
});

describe("window filter", () => {
  it("sums only the days on or after the window start", () => {
    const reading = {
      days: days(ccusageDailyFixture()),
      since: "2026-08-25",
      refreshedAt: new Date(NOW).toISOString(),
    };
    // The fixture holds 2026-08-25, 2026-09-14 and 2026-09-17.
    const wholeRun = spendBucketsSince(reading, "2026-08-25");
    const fromTheFifth = spendBucketsSince(reading, CYCLE_SINCE);
    const fromTheFifteenth = spendBucketsSince(reading, "2026-09-15");

    expect(wholeRun.totalUsd).toBeCloseTo(1096.31, 2);
    expect(fromTheFifth.totalUsd).toBeCloseTo(507.78, 2);
    expect(fromTheFifteenth.totalUsd).toBeCloseTo(186.09, 2);

    // A card whose cycle opened later sums strictly fewer of the same days.
    expect(fromTheFifth.totalUsd).toBeLessThan(wholeRun.totalUsd);
    expect(fromTheFifteenth.totalUsd).toBeLessThan(fromTheFifth.totalUsd);
    expect(fromTheFifth.claudeUsd).toBeCloseTo(491.63, 2);
    expect(fromTheFifth.otherUsd).toBeCloseTo(16.15, 2);
  });

  it("includes the window's first day itself", () => {
    const reading = {
      days: days(ccusageDailyFixture()),
      since: "2026-08-25",
      refreshedAt: new Date(NOW).toISOString(),
    };
    expect(spendBucketsSince(reading, "2026-09-17").totalUsd).toBeCloseTo(
      186.09,
      2,
    );
    expect(spendBucketsSince(reading, "2026-09-18").totalUsd).toBe(0);
  });
});

describe("ccusage cache", () => {
  function cacheFile(overrides: Record<string, unknown> = {}): void {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 2,
        refreshedAt: new Date(NOW - 60_000).toISOString(),
        since: "2026-08-24",
        days: [
          { date: "2026-08-24", models: { "claude-opus-5": 100 } },
          { date: "2026-09-21", models: { "claude-opus-5": 12 } },
          { date: "2026-09-22", models: { "gpt-6-astra": 8 } },
        ],
        ...overrides,
      }),
    );
  }

  it("serves a fresh cache without spawning", async () => {
    cacheFile();
    let spawned = 0;
    const result = await resolveCcusage(CYCLE_SINCE, {
      now: () => NOW,
      cachePath,
      run: () => {
        spawned += 1;
        return Promise.resolve(JSON.stringify(ccusagePayload()));
      },
    });
    expect(spawned).toBe(0);
    expect(result).toEqual({
      status: "measured",
      reading: {
        days: [
          { date: "2026-08-24", models: { "claude-opus-5": 100 } },
          { date: "2026-09-21", models: { "claude-opus-5": 12 } },
          { date: "2026-09-22", models: { "gpt-6-astra": 8 } },
        ],
        since: "2026-08-24",
        refreshedAt: new Date(NOW - 60_000).toISOString(),
      },
    });
    // The cycle window is a filter over those days, not a second run.
    expect(
      result.status === "measured"
        ? spendBucketsSince(result.reading, CYCLE_SINCE)
        : undefined,
    ).toEqual({ claudeUsd: 12, otherUsd: 8, totalUsd: 20 });
  });

  it("serves a cache that reaches further back than this window needs", () => {
    cacheFile();
    expect(readCcusageCache(NOW, "2026-09-05", cachePath)).toBeDefined();
    // A window opening before the run started is not covered by it.
    expect(readCcusageCache(NOW, "2026-08-01", cachePath)).toBeUndefined();
  });

  it("refreshes a cache older than the ten-minute window", async () => {
    cacheFile({ refreshedAt: new Date(NOW - 11 * 60_000).toISOString() });
    let spawned = 0;
    let asked: string | undefined;
    const result = await resolveCcusage(CYCLE_SINCE, {
      now: () => NOW,
      cachePath,
      run: (since) => {
        spawned += 1;
        asked = since;
        return Promise.resolve(JSON.stringify(ccusagePayload()));
      },
    });
    expect(spawned).toBe(1);
    expect(asked).toBe("20260905");
    expect(result).toEqual({
      status: "measured",
      reading: {
        days: [
          {
            date: "2026-09-21",
            models: { "claude-opus-5": 80, "gpt-6-astra": 10 },
          },
          {
            date: "2026-09-22",
            models: { "claude-sonnet-5": 40, "[pi] gpt-5.6-sol": 20 },
          },
        ],
        since: CYCLE_SINCE,
        refreshedAt: new Date(NOW).toISOString(),
      },
    });
    // The refreshed days are written back, owner-readable only.
    const written = JSON.parse(readFileSync(cachePath, "utf8")) as {
      version: number;
      since: string;
      days: SpendDay[];
    };
    expect(written.version).toBe(2);
    expect(written.since).toBe(CYCLE_SINCE);
    expect(written.days[0]?.models["claude-opus-5"]).toBe(80);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it("ignores a cache written by an earlier schema rather than reading it", () => {
    // The v1 summary: one summed window, with no days to filter.
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        refreshedAt: new Date(NOW - 60_000).toISOString(),
        windowDays: 30,
        since: "20260824",
        models: { "claude-opus-5": 12 },
      }),
    );
    expect(() => readCcusageCache(NOW, CYCLE_SINCE, cachePath)).not.toThrow();
    expect(readCcusageCache(NOW, CYCLE_SINCE, cachePath)).toBeUndefined();
    cacheFile({ version: 3 });
    expect(readCcusageCache(NOW, CYCLE_SINCE, cachePath)).toBeUndefined();
    cacheFile({ days: "not an array" });
    expect(readCcusageCache(NOW, CYCLE_SINCE, cachePath)).toBeUndefined();
  });

  it("reports pending while the refresh is in flight and never waits for it", async () => {
    let resolveRun: (value: string) => void = () => {};
    const deps = {
      now: () => NOW,
      cachePath,
      run: () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
    };
    primeCcusage(CYCLE_SINCE, deps);
    expect(peekCcusage(CYCLE_SINCE, deps)).toEqual({ status: "pending" });
    resolveRun(JSON.stringify(ccusagePayload()));
    await resolveCcusage(CYCLE_SINCE, deps);
    expect(peekCcusage(CYCLE_SINCE, deps)).toMatchObject({
      status: "measured",
    });
  });

  it("joins an in-flight refresh instead of spawning a second one", async () => {
    let spawned = 0;
    const deps = {
      now: () => NOW,
      cachePath,
      run: () => {
        spawned += 1;
        return Promise.resolve(JSON.stringify(ccusagePayload()));
      },
    };
    primeCcusage(CYCLE_SINCE, deps);
    primeCcusage(CYCLE_SINCE, deps);
    await resolveCcusage(CYCLE_SINCE, deps);
    expect(spawned).toBe(1);
  });

  it("answers a second, narrower window from the run it already has", async () => {
    let spawned = 0;
    const deps = {
      now: () => NOW,
      cachePath,
      run: () => {
        spawned += 1;
        return Promise.resolve(JSON.stringify(ccusagePayload()));
      },
    };
    await resolveCcusage("2026-09-01", deps);
    expect(peekCcusage("2026-09-22", deps)).toMatchObject({
      status: "measured",
    });
    expect(spawned).toBe(1);
  });

  it("reports unavailable when the run fails, and writes no cache", async () => {
    const result = await resolveCcusage(CYCLE_SINCE, {
      now: () => NOW,
      cachePath,
      run: () => Promise.reject(new Error("ccusage_unavailable")),
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(() => readFileSync(cachePath, "utf8")).toThrow();
  });
});
