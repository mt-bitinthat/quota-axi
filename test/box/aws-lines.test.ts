import { describe, expect, it } from "vitest";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import { formatUptime, renderQuotaTui } from "../../src/tui.js";
import { awsProvider, fixtureResponse } from "../fixtures/tui-response.js";
import type {
  ProviderAws,
  ProviderQuota,
  QuotaAxiResponse,
} from "../../src/types.js";

const CARD_COLUMNS = 49;
const CARD_INTERIOR = CARD_COLUMNS - 2;

function responseWith(
  aws: ProviderAws | undefined,
  overrides: Partial<ProviderQuota> = {},
): QuotaAxiResponse {
  const provider: ProviderQuota = {
    ...awsProvider(),
    ...overrides,
    ...(aws ? { aws } : { aws: undefined }),
  };
  return { ...fixtureResponse(), providers: [provider] };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Every rendered line of the aws card, borders included. */
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

describe("aws card", () => {
  it("titles the card with the instance type and the endpoint that named it", () => {
    const title = lineWith(responseWith(awsProvider().aws), "● aws");
    expect(title).toContain("t3.medium · imds");
  });

  it("shows the session cost and the rate behind it", () => {
    const response = responseWith(awsProvider().aws);
    expect(lineWith(response, "session")).toContain(
      "session  $0.38 AUD · 5h 12m up",
    );
    // The card interior leaves 34 columns for the figures, so the rate line
    // sheds the region it cannot fit rather than its own digits. The title
    // line already names the instance type the rate belongs to.
    expect(lineWith(response, "rate")).toContain(
      "rate     $0.07 AUD/h · t3.medium",
    );
    // Session cost is money already spent, so it is never drawn as headroom.
    expect(cardLines(response).some((line) => line.includes("█"))).toBe(false);
    expect(
      cardLines(response).some((line) => line.includes("effective unknown")),
    ).toBe(false);
  });

  it("names USD when no rate is configured", () => {
    const usdOnly: ProviderAws = {
      instanceType: "t3.medium",
      region: "ap-southeast-2",
      ratePerHourUsd: 0.0528,
      uptimeHours: 5.2,
      sessionUsd: 0.2746,
    };
    const response = responseWith(usdOnly);
    expect(lineWith(response, "session")).toContain(
      "session  $0.27 USD · 5h 12m up",
    );
    expect(lineWith(response, "rate")).toContain("rate     $0.05 USD/h");
  });

  it("renders the unavailable card with its reason", () => {
    const response = responseWith(undefined, {
      source: "unavailable",
      plan: undefined,
      state: {
        status: "unavailable",
        stale: false,
        error: "no-rate (m5.4xlarge)",
        sourcesTried: ["imds"],
      },
    });
    const lines = cardLines(response);
    expect(lines.some((line) => line.includes("○ aws"))).toBe(true);
    expect(lines.some((line) => line.includes("no-rate (m5.4xlarge)"))).toBe(
      true,
    );
    expect(
      lines.some((line) => line.includes("excluded from fleet totals")),
    ).toBe(true);
    expect(lines.some((line) => line.includes("session"))).toBe(false);
  });

  it("keeps a long uptime and a five-digit figure inside the card interior", () => {
    const wide: ProviderAws = {
      instanceType: "t3.2xlarge",
      region: "ap-southeast-2",
      ratePerHourUsd: 0.4224,
      uptimeHours: 999,
      sessionUsd: 42_197.76,
      sessionAud: 59_119.06,
      ratePerHourAud: 0.5918,
    };
    const lines = cardLines(responseWith(wide));
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(CARD_COLUMNS);
    }
    const figures = lines.filter((line) => /session|rate/.test(line));
    expect(figures).toHaveLength(2);
    for (const line of figures) {
      expect(line).not.toContain("…");
      expect(line.replace(/^│|│$/g, "").length).toBeLessThanOrEqual(
        CARD_INTERIOR,
      );
    }
    expect(lineWith(responseWith(wide), "session")).toContain(
      "session  $59,119 AUD · 999h 0m up",
    );
    // The line sheds the region rather than its own digits.
    expect(lineWith(responseWith(wide), "rate")).toContain(
      "rate     $0.59 AUD/h · t3.2xlarge",
    );
    expect(lineWith(responseWith(wide), "rate")).not.toContain(
      "ap-southeast-2",
    );
  });

  it("reports whole hours and minutes, never rolled up into days", () => {
    expect(formatUptime(0)).toBe("0h 0m");
    expect(formatUptime(5.2)).toBe("5h 12m");
    expect(formatUptime(999)).toBe("999h 0m");
    expect(formatUptime(Number.NaN)).toBe("?");
  });

  it("carries both currencies in --full TOON and in JSON", () => {
    const response = responseWith(awsProvider().aws);
    const toon = renderQuotaToon(response, "/bin/quota-axi", true);
    expect(toon).toMatch(/aws\[1\]/);
    expect(toon).toContain("sessionUsd");
    expect(toon).toContain("sessionAud");
    expect(toon).toContain("t3.medium");
    expect(toon).toContain("ap-southeast-2");

    for (const full of [false, true]) {
      const json = quotaJsonReport(response, full);
      expect(json.providers[0].aws).toEqual(awsProvider().aws);
    }
  });

  it("leaves the default TOON report without an aws block", () => {
    const toon = renderQuotaToon(
      responseWith(awsProvider().aws),
      "/bin/q",
      false,
    );
    expect(toon).not.toContain("sessionAud");
  });
});
