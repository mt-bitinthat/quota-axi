import type { ProviderQuota, QuotaAxiResponse } from "../../src/types.js";

/**
 * The human report's shared fixture fleet: two providers with real windows and
 * pace, one unbounded provider, and signed-out cards. Both the report tests and
 * the viewport tests render this so height behavior is checked against a real
 * frame rather than a hand-made block of text.
 */
export const GENERATED_AT = "2026-08-06T23:21:15.000Z";

export function claudeProvider(): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "oauth",
    plan: "max",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 3,
        percentRemaining: 97,
        resetsAt: "2026-08-07T04:00:00.000Z",
        windowSeconds: 18000,
        pace: {
          status: "behind",
          timeRemainingPercent: 92.9,
          elapsedPercent: 7.1,
          reservePercentPoints: 4.1,
          burnMultiple: 0.42,
        },
      },
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: 28,
        percentRemaining: 72,
        resetsAt: "2026-08-11T21:00:00.000Z",
        windowSeconds: 604800,
        pace: {
          status: "behind",
          timeRemainingPercent: 70,
          elapsedPercent: 30,
          reservePercentPoints: 2,
          burnMultiple: 0.93,
        },
      },
      {
        id: "model:fable",
        label: "Fable week",
        kind: "model",
        percentUsed: 15,
        percentRemaining: 85,
        resetsAt: "2026-08-11T21:00:00.000Z",
        windowSeconds: 604800,
        pace: {
          status: "behind",
          timeRemainingPercent: 70,
          elapsedPercent: 30,
          reservePercentPoints: 15,
          burnMultiple: 0.5,
        },
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: GENERATED_AT,
      sourcesTried: ["oauth-file", "keychain"],
    },
    quotaSemantics: {
      status: "known",
      description: "test",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 72,
          boundedBy: ["five_hour", "seven_day"],
          limitingWindowIds: ["seven_day"],
          pace: {
            status: "behind",
            behindWindowIds: ["five_hour", "seven_day"],
          },
          runway: {
            status: "through_reset",
            projectionConfidence: "early",
          },
        },
      ],
    },
  };
}

export function codexProvider(): ProviderQuota {
  return {
    provider: "codex",
    label: "Codex",
    source: "oauth",
    plan: "pro",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 95,
        percentRemaining: 5,
        resetsAt: "2026-08-08T03:35:39.000Z",
        windowSeconds: 604800,
        pace: {
          status: "ahead",
          timeRemainingPercent: 16.8,
          elapsedPercent: 83.2,
          reservePercentPoints: -11.8,
          burnMultiple: 1.14,
          projectedExhaustedAt: "2026-08-07T06:42:36.000Z",
        },
      },
      {
        id: "model:codex_bengalfox:7d",
        label: "GPT-5.3-Codex-Spark week",
        kind: "model",
        percentUsed: 0,
        percentRemaining: 100,
        resetsAt: "2026-08-13T23:21:15.000Z",
        windowSeconds: 604800,
        pace: { status: "unknown", reason: "missing_usage" },
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: GENERATED_AT,
      sourcesTried: ["oauth"],
    },
    quotaSemantics: {
      status: "known",
      description: "test",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          effectivePercentRemaining: 5,
          boundedBy: ["weekly"],
          limitingWindowIds: ["weekly"],
          pace: { status: "ahead", aheadWindowIds: ["weekly"] },
          runway: {
            status: "projected_exhaustion",
            usableRunwaySeconds: 26481,
            projectedExhaustedAt: "2026-08-07T06:42:36.000Z",
            limitingWindowId: "weekly",
            projectionConfidence: "established",
          },
        },
      ],
    },
  };
}

export function grokProvider(): ProviderQuota {
  return {
    provider: "grok",
    label: "Grok",
    source: "web",
    windows: [
      {
        id: "credits",
        label: "credits",
        kind: "credits",
        percentUsed: 55,
        percentRemaining: 45,
        startsAt: "2026-08-03T19:59:29.000Z",
        resetsAt: "2026-08-10T19:59:29.000Z",
        pace: {
          status: "ahead",
          timeRemainingPercent: 55.1,
          elapsedPercent: 44.9,
          reservePercentPoints: -10.1,
          burnMultiple: 1.23,
          projectedExhaustedAt: "2026-08-09T14:33:15.000Z",
        },
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: GENERATED_AT,
      authStatus: "usable",
      sourcesTried: ["web"],
    },
    quotaSemantics: {
      status: "known",
      description: "test",
      effectiveAvailability: [
        {
          scope: "all_products",
          status: "known",
          effectivePercentRemaining: 45,
          boundedBy: ["credits"],
          limitingWindowIds: ["credits"],
          pace: { status: "ahead", aheadWindowIds: ["credits"] },
          runway: {
            status: "projected_exhaustion",
            usableRunwaySeconds: 221983,
            projectedExhaustedAt: "2026-08-09T14:33:15.000Z",
            limitingWindowId: "credits",
            projectionConfidence: "established",
          },
        },
      ],
    },
  };
}

/**
 * Box-dashboard fork: an uncapped OpenRouter key. It has no spend cap, so it
 * reports no window and no bound - only the vendor's own credit and usage
 * figures, in the USD the adapter read them in.
 */
export function openRouterProvider(): ProviderQuota {
  return {
    provider: "openrouter",
    label: "OpenRouter",
    source: "api",
    windows: [],
    credits: { unlimited: true, unit: "usd" },
    openrouter: {
      creditsUsd: { bought: 140, used: 128.506740485, remaining: 11.493259515 },
      usageUsd: {
        allTime: 128.506740485,
        today: 0.12874695,
        week: 0.45737405,
        month: 13.925634871,
      },
      freeModelRequests: { used: 0, limit: 1000, remaining: 1000 },
    },
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: GENERATED_AT,
      sourcesTried: ["env:OPENROUTER_API_KEY"],
    },
  };
}

/**
 * Box-dashboard fork: this box's session cost. It reports no window and no
 * bound - a session cost is money already spent, not headroom - so its two
 * figure lines take the headline slot outright.
 */
export function awsProvider(): ProviderQuota {
  return {
    provider: "aws",
    label: "AWS",
    source: "imds",
    plan: "t3.medium",
    windows: [],
    aws: {
      instanceType: "t3.medium",
      region: "ap-southeast-2",
      ratePerHourUsd: 0.0528,
      uptimeHours: 5.2,
      sessionUsd: 0.2746,
      sessionAud: 0.38,
      ratePerHourAud: 0.074,
    },
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: GENERATED_AT,
      sourcesTried: ["imds"],
    },
  };
}

export function jevProvider(): ProviderQuota {
  return {
    provider: "jev",
    label: "Jev",
    source: "ledger",
    windows: [],
    jev: {
      today: {
        calls: 12,
        inputTokens: 2_100_000,
        outputTokens: 400_000,
        tokens: 2_500_000,
        usd: 8.75,
        aud: 12.26,
      },
      cycle: {
        calls: 40,
        inputTokens: 8_200_000,
        outputTokens: 1_600_000,
        tokens: 9_800_000,
        usd: 34.3,
        aud: 48.05,
      },
      allTime: {
        calls: 91,
        inputTokens: 18_000_000,
        outputTokens: 3_400_000,
        tokens: 21_400_000,
        usd: 74.9,
        aud: 104.93,
      },
      cycleSince: "2026-09-01",
      cycleWindowDays: 22,
      lastCallAt: "2026-09-22T07:08:40+0000",
      usdPerMTok: 3.5,
    },
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: GENERATED_AT,
      sourcesTried: ["ledger"],
    },
  };
}

export function signedOutProvider(
  provider: "cursor" | "copilot" | "kimi",
  error: string,
): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "unavailable",
    windows: [],
    state: {
      status: "auth_required",
      stale: false,
      error,
      sourcesTried: ["local"],
    },
    quotaSemantics: {
      status: "unknown",
      description: "test",
      effectiveAvailability: [],
    },
  };
}

export function fixtureResponse(): QuotaAxiResponse {
  return {
    generatedAt: GENERATED_AT,
    schemaVersion: 5,
    providers: [
      claudeProvider(),
      codexProvider(),
      signedOutProvider("cursor", "Cursor sign-in required"),
      signedOutProvider("copilot", "GitHub Copilot sign-in required"),
      grokProvider(),
      signedOutProvider("kimi", "unsupported_credential_type"),
    ],
  };
}
