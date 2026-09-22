import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { annotateBoxLines } from "../../src/box/annotate.js";
import { resetCcusageState, type SpendDeps } from "../../src/spend/ccusage.js";
import { fixtureResponse } from "../fixtures/tui-response.js";
import { ccusagePayload } from "../fixtures/ccusage.js";
import type { QuotaAxiResponse } from "../../src/types.js";

const NOW = new Date(2026, 8, 22, 10, 0, 0);

let directory: string;

function configPath(contents: unknown): string {
  const path = join(directory, "box.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

function spendDeps(): SpendDeps {
  return {
    now: () => NOW.getTime(),
    cachePath: join(directory, "ccusage-daily.json"),
    run: () => Promise.resolve(JSON.stringify(ccusagePayload())),
  };
}

function annotate(
  overrides: Partial<Parameters<typeof annotateBoxLines>[1]> = {},
): Promise<QuotaAxiResponse> {
  return annotateBoxLines(fixtureResponse(), {
    awaitSpend: true,
    now: NOW,
    spendDeps: spendDeps(),
    ...overrides,
  });
}

function provider(response: QuotaAxiResponse, id: string) {
  return response.providers.find((entry) => entry.provider === id);
}

beforeEach(() => {
  resetCcusageState();
  directory = mkdtempSync(join(tmpdir(), "quota-axi-box-annotate-"));
});

afterEach(() => {
  resetCcusageState();
  rmSync(directory, { recursive: true, force: true });
});

describe("annotateBoxLines", () => {
  it("attaches the configured renewal to each named provider", async () => {
    const response = await annotate({
      configPath: configPath({
        fx: { audPerUsd: 1.401, asOf: "2026-09-21" },
        subscriptions: {
          claude: { renewsDay: 5, amountAud: 305 },
          codex: { renewsDay: 5, amountAud: 35 },
        },
      }),
    });
    expect(provider(response, "claude")?.subscription).toEqual({
      renewsAt: "2026-10-05",
      amountAud: 305,
      daysUntil: 13,
      warnDays: 3,
    });
    expect(provider(response, "codex")?.subscription).toEqual({
      renewsAt: "2026-10-05",
      amountAud: 35,
      daysUntil: 13,
      warnDays: 3,
    });
    // An unconfigured provider is simply not a subscription this box has.
    expect(provider(response, "grok")?.subscription).toBeUndefined();
  });

  it("omits the subscription when there is no configuration file", async () => {
    const response = await annotate({
      configPath: join(directory, "absent.json"),
    });
    for (const entry of response.providers) {
      expect(entry.subscription).toBeUndefined();
    }
  });

  it("omits the subscription when the configuration is malformed", async () => {
    const path = join(directory, "box.json");
    writeFileSync(path, "{ not json");
    const response = await annotate({ configPath: path });
    for (const entry of response.providers) {
      expect(entry.subscription).toBeUndefined();
    }
  });

  it("splits ccusage spend into the claude and codex cards in AUD", async () => {
    const response = await annotate({
      configPath: configPath({
        fx: { audPerUsd: 2 },
        subscriptions: { claude: { renewsDay: 5, amountAud: 305 } },
      }),
    });
    expect(provider(response, "claude")?.spend).toEqual({
      windowDays: 18,
      since: "2026-09-05",
      status: "measured",
      usd: 120,
      aud: 240,
      source: "ccusage",
      refreshedAt: NOW.toISOString(),
    });
    // Codex has no entry here, so its figure keeps the rolling fallback window.
    expect(provider(response, "codex")?.spend).toEqual({
      windowDays: 30,
      since: "2026-08-24",
      status: "measured",
      usd: 30,
      aud: 60,
      source: "ccusage",
      refreshedAt: NOW.toISOString(),
    });
    // Only the two cards that own a bucket carry the line.
    expect(provider(response, "grok")?.spend).toBeUndefined();
  });

  it("falls back to the rolling window for a card with no subscription", async () => {
    const response = await annotate({
      configPath: configPath({
        subscriptions: { claude: { renewsDay: 5, amountAud: 305 } },
      }),
    });
    expect(provider(response, "claude")?.spend).toMatchObject({
      windowDays: 18,
      since: "2026-09-05",
    });
    // Codex is billed by this box under no entry, so it keeps a rolling month.
    expect(provider(response, "codex")?.spend).toMatchObject({
      windowDays: 30,
      since: "2026-08-24",
    });
  });

  it("runs ccusage once, for the earliest window any card needs", async () => {
    const asked: string[] = [];
    const response = await annotate({
      configPath: configPath({
        subscriptions: {
          claude: { renewsDay: 5, amountAud: 305 },
          codex: { renewsDay: 20, amountAud: 35 },
        },
      }),
      spendDeps: {
        ...spendDeps(),
        run: (since) => {
          asked.push(since);
          return Promise.resolve(
            JSON.stringify({
              daily: [
                {
                  period: "2026-09-10",
                  modelBreakdowns: [
                    { modelName: "claude-opus-5", cost: 7 },
                    { modelName: "gpt-6-astra", cost: 11 },
                  ],
                },
                {
                  period: "2026-09-21",
                  modelBreakdowns: [
                    { modelName: "claude-opus-5", cost: 5 },
                    { modelName: "gpt-6-astra", cost: 3 },
                  ],
                },
              ],
            }),
          );
        },
      },
    });
    // One subprocess, reaching back to the earlier of the two cycles.
    expect(asked).toEqual(["20260905"]);
    // Claude's cycle opened on the 5th and holds both days.
    expect(provider(response, "claude")?.spend).toMatchObject({
      windowDays: 18,
      since: "2026-09-05",
      usd: 12,
    });
    // Codex's opened on the 20th, so the 10th is another cycle's traffic.
    expect(provider(response, "codex")?.spend).toMatchObject({
      windowDays: 3,
      since: "2026-09-20",
      usd: 3,
    });
  });

  it("leaves the figure in USD when no rate is configured", async () => {
    const response = await annotate({
      configPath: configPath({
        subscriptions: { claude: { renewsDay: 5, amountAud: 305 } },
      }),
    });
    expect(provider(response, "claude")?.spend).toMatchObject({
      usd: 120,
    });
    expect(provider(response, "claude")?.spend?.aud).toBeUndefined();
  });

  it("reports a pending figure rather than waiting when the report is a frame", async () => {
    let resolveRun: (value: string) => void = () => {};
    const pending = new Promise<string>((resolve) => {
      resolveRun = resolve;
    });
    const response = await annotate({
      awaitSpend: false,
      configPath: join(directory, "absent.json"),
      spendDeps: { ...spendDeps(), run: () => pending },
    });
    expect(provider(response, "claude")?.spend).toEqual({
      windowDays: 30,
      since: "2026-08-24",
      status: "pending",
      source: "ccusage",
    });
    resolveRun(JSON.stringify(ccusagePayload()));
  });

  it("reports the figure as unavailable when ccusage cannot run", async () => {
    const response = await annotate({
      configPath: join(directory, "absent.json"),
      spendDeps: {
        ...spendDeps(),
        run: () => Promise.reject(new Error("ccusage_unavailable")),
      },
    });
    expect(provider(response, "claude")?.spend).toEqual({
      windowDays: 30,
      since: "2026-08-24",
      status: "unavailable",
      source: "ccusage",
    });
  });
});
