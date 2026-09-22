import { describe, expect, it } from "vitest";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import { formatCardMoney, renderQuotaTui } from "../../src/tui.js";
import {
  fixtureResponse,
  openRouterProvider,
} from "../fixtures/tui-response.js";
import type {
  ProviderOpenRouter,
  ProviderQuota,
  QuotaAxiResponse,
} from "../../src/types.js";

const CARD_COLUMNS = 49;
const CARD_INTERIOR = CARD_COLUMNS - 2;
/** 1.401 AUD per USD, the rate the committed sample box.json carries. */
const AUD_FIGURES: ProviderOpenRouter = {
  creditsUsd: { bought: 140, used: 128.506740485, remaining: 11.493259515 },
  creditsAud: { bought: 196.14, used: 180.04, remaining: 16.1 },
  usageUsd: {
    allTime: 128.506740485,
    today: 0.12874695,
    week: 0.45737405,
    month: 13.925634871,
  },
  usageAud: { allTime: 180.04, today: 0.18, week: 0.64, month: 19.51 },
  freeModelRequests: { used: 0, limit: 1000, remaining: 1000 },
};

function responseWith(
  figures: ProviderOpenRouter | undefined,
  overrides: Partial<ProviderQuota> = {},
): QuotaAxiResponse {
  const base = fixtureResponse();
  const openrouter: ProviderQuota = {
    ...openRouterProvider(),
    ...overrides,
    ...(figures ? { openrouter: figures } : { openrouter: undefined }),
  };
  return { ...base, providers: [openrouter] };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Every rendered line of the OpenRouter card, borders included. */
function cardLines(response: QuotaAxiResponse): string[] {
  return renderQuotaTui(response, {
    timeZone: "America/Los_Angeles",
    colorDepth: "none",
  })
    .split("\n")
    .map((line) => stripAnsi(line).slice(0, CARD_COLUMNS));
}

function lineWith(response: QuotaAxiResponse, needle: string): string {
  const line = cardLines(response).find((candidate) =>
    candidate.includes(needle),
  );
  expect(
    line,
    `expected a card line containing ${JSON.stringify(needle)}`,
  ).toBeDefined();
  return line as string;
}

describe("openrouter card figures", () => {
  it("replaces the bare unlimited line with the three figure lines", () => {
    const lines = cardLines(responseWith(AUD_FIGURES));
    expect(lines.some((line) => line.includes("unlimited"))).toBe(false);
    expect(lineWith(responseWith(AUD_FIGURES), "credits")).toContain(
      "credits  $16 AUD left · $180 used of $196",
    );
    expect(lineWith(responseWith(AUD_FIGURES), "today")).toContain(
      "today    $0.18 AUD · week $0.64 · month $20",
    );
    expect(lineWith(responseWith(AUD_FIGURES), "free")).toContain(
      "free     0 of 1000 requests today",
    );
  });

  it("keeps the unlimited line when there are no figures", () => {
    const lines = cardLines(responseWith(undefined));
    expect(lines.some((line) => line.includes("unlimited"))).toBe(true);
    expect(lines.some((line) => line.includes("requests today"))).toBe(false);
  });

  it("names USD when no rate is configured", () => {
    const usdOnly: ProviderOpenRouter = {
      creditsUsd: AUD_FIGURES.creditsUsd,
      usageUsd: AUD_FIGURES.usageUsd,
      freeModelRequests: AUD_FIGURES.freeModelRequests,
    };
    expect(lineWith(responseWith(usdOnly), "credits")).toContain(
      "credits  $11 USD left · $129 used of $140",
    );
    expect(lineWith(responseWith(usdOnly), "today")).toContain(
      "today    $0.13 USD · week $0.46 · month $14",
    );
  });

  it("shows only the lines whose figures the reading has", () => {
    const lines = cardLines(
      responseWith({
        freeModelRequests: { used: 7, limit: 50, remaining: 43 },
      }),
    );
    expect(lines.some((line) => line.startsWith("│   free     7 of 50"))).toBe(
      true,
    );
    // A label column the reading has no figures for is absent, not blank.
    expect(lines.some((line) => line.startsWith("│   credits"))).toBe(false);
    expect(lines.some((line) => line.startsWith("│   today"))).toBe(false);
  });

  it("keeps five-digit figures inside the card interior", () => {
    const wide: ProviderOpenRouter = {
      creditsUsd: { bought: 99999, used: 99999, remaining: 99999 },
      creditsAud: { bought: 99999, used: 99999, remaining: 99999 },
      usageUsd: { allTime: 99999, today: 99999, week: 99999, month: 99999 },
      usageAud: { allTime: 99999, today: 99999, week: 99999, month: 99999 },
      freeModelRequests: { used: 99999, limit: 99999, remaining: 0 },
    };
    const lines = cardLines(responseWith(wide));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(CARD_COLUMNS);
    }
    // Each line sheds its least useful part rather than its own digits.
    const figures = lines.filter((line) => /credits|today|free/.test(line));
    expect(figures).toHaveLength(3);
    for (const line of figures) {
      expect(line).not.toContain("…");
      expect(line.replace(/^│|│$/g, "").length).toBeLessThanOrEqual(
        CARD_INTERIOR,
      );
    }
    expect(lineWith(responseWith(wide), "credits")).toContain(
      "credits  $99,999 AUD left",
    );
    expect(lineWith(responseWith(wide), "today")).toContain(
      "today    $99,999 AUD · mo $99,999",
    );
  });

  it("keeps a capped key's headline bar and puts the figures below it", () => {
    const capped = responseWith(AUD_FIGURES, {
      credits: { remaining: 25, unit: "usd" },
      windows: [
        {
          id: "key-limit",
          label: "Key spend cap",
          kind: "credits",
          spentUsd: 75,
          limitUsd: 100,
          percentRemaining: 25,
        },
      ],
    });
    const lines = cardLines(capped);
    const bar = lines.findIndex((line) => line.includes("key sp"));
    const credits = lines.findIndex((line) => line.includes("credits  $16"));
    expect(bar).toBeGreaterThan(0);
    expect(credits).toBeGreaterThan(bar);
  });

  it("prints cents below ten dollars and whole dollars above", () => {
    expect(formatCardMoney(0.16)).toBe("$0.16");
    expect(formatCardMoney(0)).toBe("$0.00");
    expect(formatCardMoney(9.994)).toBe("$9.99");
    expect(formatCardMoney(10)).toBe("$10");
    expect(formatCardMoney(19.51)).toBe("$20");
    expect(formatCardMoney(-4.5)).toBe("-$4.50");
    expect(formatCardMoney(-1234.5)).toBe("-$1,235");
    expect(formatCardMoney(Number.NaN)).toBe("?");
  });

  it("carries both currencies in --full TOON and in JSON", () => {
    const response = responseWith(AUD_FIGURES);
    const toon = renderQuotaToon(response, "/bin/quota-axi", true);
    expect(toon).toContain("creditsRemainingUsd");
    expect(toon).toContain("creditsRemainingAud");
    expect(toon).toMatch(/openrouter\[1\]/);
    expect(toon).toContain("196.14");
    expect(toon).toContain("1000");

    for (const full of [false, true]) {
      const json = quotaJsonReport(response, full);
      expect(json.providers[0].openrouter).toEqual(AUD_FIGURES);
    }
  });

  it("leaves the default TOON report without an openrouter block", () => {
    const toon = renderQuotaToon(responseWith(AUD_FIGURES), "/bin/q", false);
    expect(toon).not.toContain("creditsRemainingAud");
  });
});
