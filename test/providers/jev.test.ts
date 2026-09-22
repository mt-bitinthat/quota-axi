import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BoxConfig } from "../../src/box/config.js";
import { createJevAdapter, jevLedgerPath } from "../../src/providers/jev.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };

/**
 * A fixed local noon on 22 September 2026. Local rather than UTC because every
 * window the provider aggregates is a local calendar window, and a midnight
 * anchor would put the fixture's own entries on either side of it depending on
 * the machine's zone.
 */
const NOW = new Date(2026, 8, 22, 12, 0, 0);

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** The ledger's own spelling: a basic-format offset, not `+00:00`. */
function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const magnitude = Math.abs(offsetMinutes);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `${sign}${pad(Math.floor(magnitude / 60))}${pad(magnitude % 60)}`
  );
}

function entry(at: Date, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    ts: stamp(at),
    tool: "jev-find",
    model: "jev-1.13.0",
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    questions: 24,
  });
}

function ledger(lines: string[]): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-jev-"));
  const path = join(tempDir, "ledger.jsonl");
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  return path;
}

function adapter(
  overrides: { path?: string; config?: BoxConfig; now?: Date } = {},
) {
  return createJevAdapter({
    ledgerPath: () => overrides.path ?? join(tempDir ?? "/nowhere", "absent"),
    readConfig: () => overrides.config,
    now: () => (overrides.now ?? NOW).getTime(),
  });
}

/** Today, the cycle so far, and a day before this calendar month opened. */
const TODAY = new Date(2026, 8, 22, 7, 8, 40);
const EARLIER_TODAY = new Date(2026, 8, 22, 1, 30, 0);
const THIS_MONTH = new Date(2026, 8, 10, 9, 0, 0);
const LAST_MONTH = new Date(2026, 7, 20, 9, 0, 0);

function fixtureLedger(): string {
  return ledger([
    entry(LAST_MONTH, 1_000, 100),
    entry(THIS_MONTH, 20_000, 4_000),
    entry(EARLIER_TODAY, 2_442, 426),
    entry(TODAY, 19_571, 3_694),
  ]);
}

describe("Jev ledger provider", () => {
  it("sums today, the cycle and all time from the ledger", async () => {
    const report = await adapter({ path: fixtureLedger() }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "jev",
      source: "ledger",
      windows: [],
      state: { status: "fresh", stale: false },
      attempts: [{ source: "ledger", status: "success" }],
    });
    expect(report.plan).toBeUndefined();
    expect(report.jev).toEqual({
      today: {
        calls: 2,
        inputTokens: 22_013,
        outputTokens: 4_120,
        tokens: 26_133,
      },
      cycle: {
        calls: 3,
        inputTokens: 42_013,
        outputTokens: 8_120,
        tokens: 50_133,
      },
      allTime: {
        calls: 4,
        inputTokens: 43_013,
        outputTokens: 8_220,
        tokens: 51_233,
      },
      // No `jev` subscription entry, so the cycle is the calendar month.
      cycleSince: "2026-09-01",
      cycleWindowDays: 22,
      lastCallAt: stamp(TODAY),
    });
  });

  it("skips a malformed line without losing the lines around it", async () => {
    const path = ledger([
      entry(EARLIER_TODAY, 2_442, 426),
      "{not json at all",
      "[1, 2, 3]",
      JSON.stringify({
        ts: "not a timestamp",
        input_tokens: 5,
        output_tokens: 5,
      }),
      JSON.stringify({ ts: stamp(TODAY), output_tokens: 5 }),
      JSON.stringify({ ts: stamp(TODAY), input_tokens: -1, output_tokens: 5 }),
      // A torn final append: the ledger is written by several tools at once.
      '{"ts": "2026-09-22T07:08:40+0000", "input_tok',
      entry(TODAY, 19_571, 3_694),
    ]);
    const report = await adapter({ path }).fetchQuota(OPTIONS);

    expect(report.jev?.allTime).toEqual({
      calls: 2,
      inputTokens: 22_013,
      outputTokens: 4_120,
      tokens: 26_133,
    });
  });

  it("opens the cycle on the configured renewal day rather than the month", async () => {
    const config: BoxConfig = {
      subscriptions: { jev: { renewsDay: 15, amountAud: 20 } },
    };
    const report = await adapter({
      path: fixtureLedger(),
      config,
    }).fetchQuota(OPTIONS);

    // The 10 September entry now falls before the cycle opened on the 15th.
    expect(report.jev).toMatchObject({
      cycleSince: "2026-09-15",
      cycleWindowDays: 8,
      cycle: {
        calls: 2,
        inputTokens: 22_013,
        outputTokens: 4_120,
        tokens: 26_133,
      },
    });
    // All time still counts every entry, cycle or not.
    expect(report.jev?.allTime.calls).toBe(4);
  });

  it("falls back to the calendar month for a renewal day it has no entry for", async () => {
    const config: BoxConfig = {
      subscriptions: { claude: { renewsDay: 5, amountAud: 340 } },
    };
    const report = await adapter({
      path: fixtureLedger(),
      config,
    }).fetchQuota(OPTIONS);

    expect(report.jev).toMatchObject({
      cycleSince: "2026-09-01",
      cycleWindowDays: 22,
    });
  });

  it("prices every window when a rate is configured", async () => {
    const config: BoxConfig = {
      subscriptions: {},
      jev: { usdPerMTok: 3.5 },
    };
    const report = await adapter({
      path: fixtureLedger(),
      config,
    }).fetchQuota(OPTIONS);

    expect(report.jev?.usdPerMTok).toBe(3.5);
    expect(report.jev?.today.usd).toBeCloseTo((26_133 / 1e6) * 3.5, 4);
    expect(report.jev?.cycle.usd).toBeCloseTo((50_133 / 1e6) * 3.5, 4);
    expect(report.jev?.allTime.usd).toBeCloseTo((51_233 / 1e6) * 3.5, 4);
    // The AUD half is the annotation step's, never the provider's.
    expect(report.jev?.today.aud).toBeUndefined();
  });

  it("shows counts and no money when no rate is configured", async () => {
    const report = await adapter({ path: fixtureLedger() }).fetchQuota(OPTIONS);

    expect(report.jev?.usdPerMTok).toBeUndefined();
    for (const usage of [
      report.jev?.today,
      report.jev?.cycle,
      report.jev?.allTime,
    ]) {
      expect(usage?.usd).toBeUndefined();
      expect(usage?.aud).toBeUndefined();
    }
  });

  it("reports no ledger when the file is missing", async () => {
    const report = await adapter().fetchQuota(OPTIONS);

    expect(report.state.status).toBe("unavailable");
    expect(report.state.error).toBe("no ledger");
    expect(report.jev).toBeUndefined();
    expect(report.attempts).toEqual([
      { source: "ledger", status: "failed", error: "no ledger" },
    ]);
  });

  it("reports no ledger for an empty file and for one with no usable line", async () => {
    for (const lines of [[], ["", "   ", "{broken"]]) {
      const report = await adapter({ path: ledger(lines) }).fetchQuota(OPTIONS);
      expect(report.state.error).toBe("no ledger");
      expect(report.jev).toBeUndefined();
    }
  });

  it("names the newest entry by its own timestamp, not by file order", async () => {
    const path = ledger([entry(TODAY, 100, 10), entry(EARLIER_TODAY, 100, 10)]);
    const report = await adapter({ path }).fetchQuota(OPTIONS);

    expect(report.jev?.lastCallAt).toBe(stamp(TODAY));
  });

  it("has no credential source to inspect", async () => {
    const report = await adapter().inspectAuth(OPTIONS);
    expect(report).toEqual({ provider: "jev", sources: [] });
  });

  it("reads the ledger from the jev cache directory", () => {
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/synthetic/cache";
    try {
      expect(jevLedgerPath()).toBe("/synthetic/cache/jev/ledger.jsonl");
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });
});
