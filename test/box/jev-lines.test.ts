import { describe, expect, it } from "vitest";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import { formatTokens, renderQuotaTui } from "../../src/tui.js";
import { fixtureResponse, jevProvider } from "../fixtures/tui-response.js";
import type {
  JevUsage,
  ProviderJev,
  ProviderQuota,
  QuotaAxiResponse,
} from "../../src/types.js";

const CARD_COLUMNS = 49;
const CARD_INTERIOR = CARD_COLUMNS - 2;

function responseWith(
  jev: ProviderJev | undefined,
  overrides: Partial<ProviderQuota> = {},
): QuotaAxiResponse {
  const provider: ProviderQuota = {
    ...jevProvider(),
    ...overrides,
    ...(jev ? { jev } : { jev: undefined }),
  };
  return { ...fixtureResponse(), providers: [provider] };
}

/** The same figures with every money half stripped, as an unpriced box reads. */
function unpriced(): ProviderJev {
  const priced = jevProvider().jev as ProviderJev;
  const counts = (usage: JevUsage): JevUsage => ({
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokens: usage.tokens,
  });
  return {
    ...priced,
    usdPerMTok: undefined,
    today: counts(priced.today),
    cycle: counts(priced.cycle),
    allTime: counts(priced.allTime),
  };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Every rendered line of the jev card, borders included. */
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

describe("jev card", () => {
  it("titles the card with the ledger it counted", () => {
    expect(lineWith(responseWith(jevProvider().jev), "● jev")).toContain(
      "ledger",
    );
  });

  it("shows today's and this cycle's calls, tokens and money", () => {
    const response = responseWith(jevProvider().jev);
    expect(lineWith(response, "today")).toContain(
      "today    12 calls · 2.5M tok · $12 AUD",
    );
    expect(lineWith(response, "cycle")).toContain(
      "cycle    40 calls · 9.8M tok · $48 AUD",
    );
    // Calls already made are not headroom, so nothing here is drawn as a bar.
    expect(cardLines(response).some((line) => line.includes("█"))).toBe(false);
    expect(
      cardLines(response).some((line) => line.includes("effective unknown")),
    ).toBe(false);
  });

  it("names USD when only the token rate is configured", () => {
    const priced = jevProvider().jev as ProviderJev;
    const usdOnly: ProviderJev = {
      ...priced,
      today: { ...priced.today, aud: undefined },
      cycle: { ...priced.cycle, aud: undefined },
      allTime: { ...priced.allTime, aud: undefined },
    };
    const response = responseWith(usdOnly);
    expect(lineWith(response, "today")).toContain(
      "today    12 calls · 2.5M tok · $8.75 USD",
    );
    expect(lineWith(response, "cycle")).toContain(
      "cycle    40 calls · 9.8M tok · $34 USD",
    );
  });

  it("counts calls and tokens and shows no money when unpriced", () => {
    const response = responseWith(unpriced());
    expect(lineWith(response, "today")).toContain(
      "today    12 calls · 2.5M tok",
    );
    expect(lineWith(response, "cycle")).toContain(
      "cycle    40 calls · 9.8M tok",
    );
    expect(cardLines(response).some((line) => line.includes("$"))).toBe(false);
  });

  it("renders the no-ledger card with its reason", () => {
    const response = responseWith(undefined, {
      source: "unavailable",
      state: {
        status: "unavailable",
        stale: false,
        error: "no ledger",
        sourcesTried: ["ledger"],
      },
    });
    const lines = cardLines(response);
    expect(lines.some((line) => line.includes("○ jev"))).toBe(true);
    expect(lines.some((line) => line.includes("no ledger"))).toBe(true);
    expect(
      lines.some((line) => line.includes("excluded from fleet totals")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("calls"))).toBe(false);
  });

  it("keeps a five-digit call count and a large figure inside the interior", () => {
    const priced = jevProvider().jev as ProviderJev;
    const wide: ProviderJev = {
      ...priced,
      today: {
        calls: 99_999,
        inputTokens: 800_000_000,
        outputTokens: 199_900_000,
        tokens: 999_900_000,
        usd: 3_499.65,
        aud: 4_902.99,
      },
      cycle: {
        calls: 12_345,
        inputTokens: 90_000_000,
        outputTokens: 10_000_000,
        tokens: 100_000_000,
        usd: 350,
        aud: 490.35,
      },
    };
    const response = responseWith(wide);
    for (const line of cardLines(response)) {
      expect(line.length).toBeLessThanOrEqual(CARD_COLUMNS);
    }
    const figures = cardLines(response).filter((line) =>
      /today|cycle/.test(line),
    );
    expect(figures).toHaveLength(2);
    for (const line of figures) {
      expect(line).not.toContain("…");
      expect(line.replace(/^│|│$/g, "").length).toBeLessThanOrEqual(
        CARD_INTERIOR,
      );
    }
    // The count is never what gives way: the line sheds its `tok` unit first.
    expect(lineWith(response, "today")).toContain(
      "today    99999 calls · 999.9M · $4,903 AUD",
    );
    expect(lineWith(response, "cycle")).toContain(
      "cycle    12345 calls · 100.0M · $490 AUD",
    );
  });

  it("reports thousands with no decimals and millions with one", () => {
    expect(formatTokens(0)).toBe("0k");
    expect(formatTokens(426)).toBe("<1k");
    expect(formatTokens(2_868)).toBe("3k");
    expect(formatTokens(437_901)).toBe("438k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(999_900_000)).toBe("999.9M");
    expect(formatTokens(Number.NaN)).toBe("?");
  });

  it("carries every window and both currencies in --full TOON and in JSON", () => {
    const response = responseWith(jevProvider().jev);
    const toon = renderQuotaToon(response, "/bin/quota-axi", true);
    expect(toon).toMatch(/jev\[3\]/);
    expect(toon).toContain("inputTokens");
    expect(toon).toContain("usdPerMTok");
    expect(toon).toContain("lastCallAt");

    for (const full of [false, true]) {
      const json = quotaJsonReport(response, full);
      expect(json.providers[0].jev).toEqual(jevProvider().jev);
    }
  });

  it("leaves the default TOON report without a jev block", () => {
    const toon = renderQuotaToon(
      responseWith(jevProvider().jev),
      "/bin/q",
      false,
    );
    expect(toon).not.toContain("usdPerMTok");
  });
});
