import { describe, expect, it } from "vitest";
import { renderQuotaTui } from "../../src/tui.js";
import { fixtureResponse } from "../fixtures/tui-response.js";
import type { ProviderQuota, QuotaAxiResponse } from "../../src/types.js";

const CARD_COLUMNS = 49;

type BoxFields = Pick<ProviderQuota, "subscription" | "spend">;

function responseWith(
  overrides: Partial<Record<"claude" | "codex", BoxFields>>,
): QuotaAxiResponse {
  const response = fixtureResponse();
  return {
    ...response,
    providers: response.providers.map((provider) =>
      provider.provider === "claude" || provider.provider === "codex"
        ? { ...provider, ...(overrides[provider.provider] ?? {}) }
        : provider,
    ),
  };
}

function render(response: QuotaAxiResponse, colorDepth = "none" as const) {
  return renderQuotaTui(response, {
    timeZone: "America/Los_Angeles",
    colorDepth,
  }).split("\n");
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Search one card column of the two-up grid, not the zipped row. */
function cardLine(lines: string[], card: 0 | 1, needle: string): string {
  const column = (line: string): string =>
    card === 0
      ? stripAnsi(line).slice(0, CARD_COLUMNS)
      : stripAnsi(line).slice(CARD_COLUMNS + 2);
  const line = lines
    .map(column)
    .find((candidate) => candidate.includes(needle));
  expect(
    line,
    `expected card ${card} to contain ${JSON.stringify(needle)}`,
  ).toBeDefined();
  return line as string;
}

/** The raw zipped row, escapes intact, for assertions about styling. */
function styledLine(lines: string[], needle: string): string {
  const line = lines.find((candidate) => stripAnsi(candidate).includes(needle));
  expect(
    line,
    `expected a line containing ${JSON.stringify(needle)}`,
  ).toBeDefined();
  return line as string;
}

const CLAUDE: BoxFields = {
  subscription: {
    renewsAt: "2026-10-05",
    amountAud: 305,
    daysUntil: 13,
    warnDays: 3,
  },
  spend: {
    windowDays: 30,
    status: "measured",
    usd: 3654.53,
    aud: 5120.0,
    source: "ccusage",
    refreshedAt: "2026-09-22T03:00:00.000Z",
  },
};

const CODEX: BoxFields = {
  subscription: {
    renewsAt: "2026-10-05",
    amountAud: 35,
    daysUntil: 13,
    warnDays: 3,
  },
  spend: {
    windowDays: 30,
    status: "measured",
    usd: 30.1,
    aud: 42.17,
    source: "ccusage",
    refreshedAt: "2026-09-22T03:00:00.000Z",
  },
};

describe("box dashboard card lines", () => {
  it("prints the renewal and spend lines in the claude and codex cards", () => {
    const lines = render(responseWith({ claude: CLAUDE, codex: CODEX }));
    expect(cardLine(lines, 0, "renews")).toContain(
      "renews 5 Oct · $305 AUD · 13d",
    );
    expect(cardLine(lines, 0, "API-equiv")).toContain(
      "API-equiv 30d · $5,120 AUD",
    );
    expect(cardLine(lines, 1, "renews")).toContain(
      "renews 5 Oct · $35 AUD · 13d",
    );
    expect(cardLine(lines, 1, "API-equiv")).toContain(
      "API-equiv 30d · $42 AUD",
    );
  });

  it("adds only the two lines, and leaves the rest of the grid alone", () => {
    const plain = render(fixtureResponse());
    const annotated = render(responseWith({ claude: CLAUDE, codex: CODEX }));
    // Two cards, two lines each: the claude card is one window taller than the
    // codex card, so each pair lands on its own row of the zipped grid.
    expect(annotated.filter((line) => line.includes("renews"))).toHaveLength(2);
    expect(annotated.filter((line) => line.includes("API-equiv"))).toHaveLength(
      2,
    );
    expect(annotated).toHaveLength(plain.length + 2);
    // Every row that existed before is still there, character for character.
    const added = annotated.filter(
      (line) => !line.includes("renews") && !line.includes("API-equiv"),
    );
    expect(added.filter((line) => plain.includes(line))).toEqual(added);
  });

  it("keeps the lines out of a card that has no box facts", () => {
    const lines = render(fixtureResponse());
    expect(lines.some((line) => line.includes("renews"))).toBe(false);
    expect(lines.some((line) => line.includes("API-equiv"))).toBe(false);
  });

  it("marks the countdown red at three days and at zero, but not at four", () => {
    const red = (daysUntil: number, warnDays = 3): boolean => {
      const lines = render(
        responseWith({
          claude: {
            ...CLAUDE,
            subscription: {
              renewsAt: "2026-10-05",
              amountAud: 305,
              daysUntil,
              warnDays,
            },
          },
        }),
        "truecolor",
      );
      // The crit style, applied to the day segment alone.
      return styledLine(lines, "renews").includes(
        `\x1b[38;2;243;139;168m${daysUntil}d\x1b[0m`,
      );
    };
    expect(red(0)).toBe(true);
    expect(red(3)).toBe(true);
    expect(red(4)).toBe(false);
    expect(red(13)).toBe(false);
    // The threshold comes from box.json's warnDays.
    expect(red(7, 7)).toBe(true);
    expect(red(8, 7)).toBe(false);
    expect(red(0, 0)).toBe(true);
    expect(red(1, 0)).toBe(false);
  });

  it("names the currency the figure was priced in when no rate is configured", () => {
    const lines = render(
      responseWith({
        claude: {
          spend: {
            windowDays: 30,
            status: "measured",
            usd: 3654.53,
            source: "ccusage",
            refreshedAt: "2026-09-22T03:00:00.000Z",
          },
        },
      }),
    );
    expect(cardLine(lines, 0, "API-equiv")).toContain(
      "API-equiv 30d · $3,655 USD",
    );
  });

  it("shows a pending figure rather than an absent one", () => {
    const lines = render(
      responseWith({
        claude: {
          spend: { windowDays: 30, status: "pending", source: "ccusage" },
        },
      }),
    );
    expect(cardLine(lines, 0, "API-equiv")).toContain("API-equiv 30d · …");
  });

  it("names the remedy when ccusage cannot run", () => {
    const lines = render(
      responseWith({
        claude: {
          spend: { windowDays: 30, status: "unavailable", source: "ccusage" },
        },
      }),
    );
    // No figure, so no window label: the remedy takes that room instead.
    expect(cardLine(lines, 0, "API-equiv")).toContain(
      "API-equiv · unavailable (npm i -g ccusage)",
    );
  });
});
