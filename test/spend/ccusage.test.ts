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
  ccusageModelCosts,
  ccusageSince,
  peekCcusage,
  primeCcusage,
  readCcusageCache,
  resetCcusageState,
  resolveCcusage,
  SPEND_WINDOW_DAYS,
} from "../../src/spend/ccusage.js";
import { ccusageDailyFixture, ccusagePayload } from "../fixtures/ccusage.js";

const NOW = Date.UTC(2026, 8, 22, 3, 0, 0);

let directory: string;
let cachePath: string;

beforeEach(() => {
  resetCcusageState();
  directory = mkdtempSync(join(tmpdir(), "quota-axi-ccusage-"));
  cachePath = join(directory, "ccusage-30d.json");
});

afterEach(() => {
  resetCcusageState();
  rmSync(directory, { recursive: true, force: true });
});

describe("ccusage bucketing", () => {
  it("splits a real ccusage window into two buckets that sum to its own total", () => {
    const payload = ccusageDailyFixture() as {
      totals: { totalCost: number };
    };
    const costs = ccusageModelCosts(payload);
    expect(costs).toBeDefined();
    const buckets = bucketModelCosts(costs as Record<string, number>);

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
      ccusageModelCosts({
        daily: [
          {
            modelBreakdowns: [
              { modelName: "claude-opus-5", cost: 4 },
              { modelName: "claude-opus-5", cost: "3" },
              { cost: 9 },
              { modelName: "gpt-6-astra" },
              null,
            ],
          },
          { modelBreakdowns: "none" },
        ],
      }),
    ).toEqual({ "claude-opus-5": 4 });
  });

  it("resolves undefined for output that is not a ccusage report", () => {
    expect(ccusageModelCosts({})).toBeUndefined();
    expect(ccusageModelCosts([])).toBeUndefined();
    expect(ccusageModelCosts("nope")).toBeUndefined();
  });

  it("asks for a window of whole calendar days ending today", () => {
    // 30 days inclusive of today, so a local 2026-09-22 starts on 2026-08-24.
    const local = new Date(2026, 8, 22, 10).getTime();
    expect(ccusageSince(local)).toBe("20260824");
    expect(SPEND_WINDOW_DAYS).toBe(30);
  });
});

describe("ccusage cache", () => {
  it("serves a fresh cache without spawning", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        refreshedAt: new Date(NOW - 60_000).toISOString(),
        windowDays: 30,
        since: "20260824",
        models: { "claude-opus-5": 12, "gpt-6-astra": 8 },
      }),
    );
    let spawned = 0;
    const result = await resolveCcusage({
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
        buckets: { claudeUsd: 12, otherUsd: 8, totalUsd: 20 },
        refreshedAt: new Date(NOW - 60_000).toISOString(),
      },
    });
  });

  it("refreshes a cache older than the ten-minute window", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        refreshedAt: new Date(NOW - 11 * 60_000).toISOString(),
        windowDays: 30,
        since: "20260824",
        models: { "claude-opus-5": 12 },
      }),
    );
    let spawned = 0;
    const result = await resolveCcusage({
      now: () => NOW,
      cachePath,
      run: () => {
        spawned += 1;
        return Promise.resolve(JSON.stringify(ccusagePayload()));
      },
    });
    expect(spawned).toBe(1);
    expect(result).toEqual({
      status: "measured",
      reading: {
        buckets: { claudeUsd: 120, otherUsd: 30, totalUsd: 150 },
        refreshedAt: new Date(NOW).toISOString(),
      },
    });
    // The refreshed summary is written back, owner-readable only.
    const written = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models: Record<string, number>;
    };
    expect(written.models["claude-opus-5"]).toBe(80);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
  });

  it("rejects a cache written for a different window or schema", () => {
    const refreshedAt = new Date(NOW - 60_000).toISOString();
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 1, refreshedAt, windowDays: 7, models: {} }),
    );
    expect(readCcusageCache(NOW, cachePath)).toBeUndefined();
    writeFileSync(
      cachePath,
      JSON.stringify({ version: 2, refreshedAt, windowDays: 30, models: {} }),
    );
    expect(readCcusageCache(NOW, cachePath)).toBeUndefined();
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
    primeCcusage(deps);
    expect(peekCcusage(deps)).toEqual({ status: "pending" });
    resolveRun(JSON.stringify(ccusagePayload()));
    await resolveCcusage(deps);
    expect(peekCcusage(deps)).toMatchObject({ status: "measured" });
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
    primeCcusage(deps);
    primeCcusage(deps);
    await resolveCcusage(deps);
    expect(spawned).toBe(1);
  });

  it("reports unavailable when the run fails, and writes no cache", async () => {
    const result = await resolveCcusage({
      now: () => NOW,
      cachePath,
      run: () => Promise.reject(new Error("ccusage_unavailable")),
    });
    expect(result).toEqual({ status: "unavailable" });
    expect(() => readFileSync(cachePath, "utf8")).toThrow();
  });
});
