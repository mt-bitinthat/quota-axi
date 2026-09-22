import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Three days trimmed from a real `ccusage daily --json` run on the box this
 * fork targets, with `totals` recomputed over the kept days. It carries the
 * real shape - per-day `modelBreakdowns`, a Pi-prefixed model name, and both
 * Claude and GPT rows - and nothing but token counts, model names, and costs.
 */
export function ccusageDailyFixture(): unknown {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./ccusage-daily.json", import.meta.url)),
      "utf8",
    ),
  ) as unknown;
}

/** Round costs, so a conversion or a bucket split is readable in the assertion. */
export function ccusagePayload(): unknown {
  return {
    daily: [
      {
        period: "2026-09-21",
        modelBreakdowns: [
          { modelName: "claude-opus-5", cost: 80 },
          { modelName: "gpt-6-astra", cost: 10 },
        ],
        totalCost: 90,
      },
      {
        period: "2026-09-22",
        modelBreakdowns: [
          { modelName: "claude-sonnet-5", cost: 40 },
          { modelName: "[pi] gpt-5.6-sol", cost: 20 },
        ],
        totalCost: 60,
      },
    ],
    totals: { totalCost: 150 },
  };
}
