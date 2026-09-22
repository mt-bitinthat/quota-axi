import { describe, expect, it, vi } from "vitest";
import {
  createOpenRouterAdapter,
  extractOpenRouterCredential,
  normalizeOpenRouterCredits,
  normalizeOpenRouterPayload,
  OPENROUTER_CREDITS_URL,
  OPENROUTER_KEY_URL,
  resolveOpenRouterCredentials,
} from "../../src/providers/openrouter.js";
import KEY_FIXTURE from "../fixtures/openrouter/key.json" with { type: "json" };
import CREDITS_FIXTURE from "../fixtures/openrouter/credits.json" with { type: "json" };

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-openrouter-key";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

/** Answer each endpoint with its own body, the way the vendor does. */
function bothEndpoints(key: unknown, credits: unknown) {
  return vi.fn(async (url: string) =>
    url === OPENROUTER_CREDITS_URL ? json(credits) : json(key),
  );
}

describe("OpenRouter provider", () => {
  it("reports the key spend cap and remaining balance", async () => {
    const request = vi.fn(async (url: string) =>
      url === OPENROUTER_CREDITS_URL
        ? json({ data: { total_credits: 200, total_usage: 26.75 } })
        : json({
            data: {
              label: "personal",
              limit: 100,
              limit_remaining: 73.25,
              limit_reset: "Daily",
              usage: 26.75,
              usage_daily: 5,
              usage_weekly: 15,
              usage_monthly: 26.75,
              is_free_tier: false,
            },
          }),
    );

    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "openrouter",
      source: "api",
      state: { status: "fresh", stale: false },
      credits: { remaining: 73.25, unit: "usd" },
      account: { accountId: "personal", identityStatus: "unverified" },
      attempts: [{ source: "env:OPENROUTER_API_KEY", status: "success" }],
    });
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        kind: "credits",
        spentUsd: 26.75,
        limitUsd: 100,
        percentRemaining: 73.25,
        resetText: "Daily",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(KEY);
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      OPENROUTER_KEY_URL,
      OPENROUTER_CREDITS_URL,
    ]);
    const init = request.mock.calls[0][1];
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("tries Pi auth after an environment key is rejected", async () => {
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = new Headers(init?.headers).get("authorization");
      if (bearer === "Bearer stale-env-key")
        return new Response(null, { status: 403 });
      return new Response(
        JSON.stringify({ data: { limit: 100, limit_remaining: 40 } }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const report = await createOpenRouterAdapter({
      credential: () => [
        {
          status: "available",
          key: "stale-env-key",
          source: "env:OPENROUTER_API_KEY",
        },
        { status: "available", key: KEY, source: "pi:openrouter" },
      ],
      fetch: request,
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      state: {
        status: "fresh",
        sourcesTried: ["env:OPENROUTER_API_KEY", "pi:openrouter"],
      },
      attempts: [
        {
          source: "env:OPENROUTER_API_KEY",
          status: "failed",
          error: "provider_auth_rejected",
        },
        { source: "pi:openrouter", status: "success" },
      ],
      credits: { remaining: 40, unit: "usd" },
    });
    // Key rejected, then the working key's own key and credits reads.
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("treats a null cap as unlimited and omits the window", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              limit: null,
              limit_remaining: null,
              usage: 10,
              usage_daily: 10,
              usage_weekly: 10,
              usage_monthly: 10,
              is_free_tier: true,
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      windows: [],
      credits: { unlimited: true, unit: "usd" },
    });
  });

  it("omits credits when a finite cap lacks remaining balance", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(JSON.stringify({ data: { limit: 100, usage: 10 } }), {
          headers: { "content-type": "application/json" },
        }),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([]);
    expect(report.credits).toBeUndefined();
  });

  it("reports an over-cap key as spent with a negative remaining balance", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(
          JSON.stringify({ data: { limit: 100, limit_remaining: -5 } }),
          { headers: { "content-type": "application/json" } },
        ),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        limitUsd: 100,
        spentUsd: 105,
        percentRemaining: 0,
      }),
    ]);
    expect(report.credits).toEqual({ remaining: -5, unit: "usd" });
  });

  it("reports a zero finite cap as fully spent", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(
          JSON.stringify({ data: { limit: 0, limit_remaining: 0 } }),
          { headers: { "content-type": "application/json" } },
        ),
      now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.windows).toEqual([
      expect.objectContaining({
        id: "key-limit",
        limitUsd: 0,
        spentUsd: 0,
        percentRemaining: 0,
      }),
    ]);
    expect(report.credits).toEqual({ remaining: 0, unit: "usd" });
  });

  it("publishes both endpoints' figures in USD", async () => {
    const request = bothEndpoints(KEY_FIXTURE, CREDITS_FIXTURE);
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-22T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.openrouter).toEqual({
      creditsUsd: { bought: 140, used: 128.506740485, remaining: 11.493259515 },
      usageUsd: {
        allTime: 128.506740485,
        today: 0.12874695,
        week: 0.45737405,
        month: 13.925634871,
      },
      freeModelRequests: { used: 0, limit: 1000, remaining: 1000 },
    });
    // Raw USD only: the data layer never converts.
    expect(JSON.stringify(report.openrouter)).not.toContain("aud");
    const creditsInit = request.mock.calls[1][1];
    expect(new Headers(creditsInit?.headers).get("authorization")).toBe(
      "Bearer " + KEY,
    );
  });

  it("keeps the key figures when the credits call fails", async () => {
    const request = vi.fn(async (url: string) =>
      url === OPENROUTER_CREDITS_URL
        ? new Response(null, { status: 500 })
        : json(KEY_FIXTURE),
    );
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: request,
      now: () => Date.parse("2026-09-22T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.openrouter?.creditsUsd).toBeUndefined();
    expect(report.openrouter?.usageUsd).toEqual({
      allTime: 128.506740485,
      today: 0.12874695,
      week: 0.45737405,
      month: 13.925634871,
    });
    expect(report.openrouter?.freeModelRequests).toEqual({
      used: 0,
      limit: 1000,
      remaining: 1000,
    });
  });

  it("omits a usage row the endpoint reported only half of", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: bothEndpoints(
        { data: { limit: null, usage: 10, usage_daily: 1 } },
        { data: {} },
      ),
      now: () => Date.parse("2026-09-22T00:00:00.000Z"),
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.openrouter).toBeUndefined();
  });

  it("reads the credits endpoint's two figures", () => {
    expect(normalizeOpenRouterCredits(CREDITS_FIXTURE)).toEqual({
      bought: 140,
      used: 128.506740485,
    });
    expect(normalizeOpenRouterCredits({ data: { total_credits: 10 } })).toBe(
      undefined,
    );
    expect(normalizeOpenRouterCredits({ error: "nope" })).toBe(undefined);
  });

  it("rejects an invalid payload", () => {
    expect(() => normalizeOpenRouterPayload({ error: "test" })).toThrow(
      "missing_data",
    );
    expect(() => normalizeOpenRouterPayload({ data: { usage: 10 } })).toThrow(
      "invalid_limit",
    );
  });

  it("reports unusable local credentials as auth_required", async () => {
    const request = vi.fn();
    const deleteCachedProvider = vi.fn();
    const missing = await createOpenRouterAdapter({
      credential: () => ({ status: "missing", source: "pi:openrouter" }),
      fetch: request,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);
    const invalid = await createOpenRouterAdapter({
      credential: () => ({ status: "invalid", source: "pi:openrouter" }),
      fetch: request,
      deleteCachedProvider,
    }).fetchQuota(OPTIONS);
    expect(missing).toMatchObject({
      provider: "openrouter",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "openrouter_credential_unavailable",
      },
    });
    expect(invalid).toMatchObject({
      provider: "openrouter",
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "openrouter_credential_invalid",
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(deleteCachedProvider).toHaveBeenCalledWith("openrouter");
  });

  it("enumerates the environment source even when unset", () => {
    expect(resolveOpenRouterCredentials({}, "/missing/auth.json")).toEqual([
      { status: "missing", source: "env:OPENROUTER_API_KEY" },
      {
        status: "missing",
        source: "pi:openrouter",
        path: "/missing/auth.json",
      },
    ]);
  });

  it("extracts a Pi auth.json openrouter entry", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { apiKey: KEY } },
        "/auth.json",
      ),
    ).toEqual({
      status: "available",
      key: KEY,
      source: "pi:openrouter",
      path: "/auth.json",
    });
  });

  it("rejects template and scalar Pi auth entries as invalid", () => {
    expect(
      extractOpenRouterCredential(
        { openrouter: { apiKey: "${OPENROUTER_API_KEY}" } },
        "/auth.json",
      ),
    ).toEqual({
      status: "invalid",
      source: "pi:openrouter",
      path: "/auth.json",
    });
    expect(
      extractOpenRouterCredential({ openrouter: KEY }, "/auth.json"),
    ).toEqual({
      status: "invalid",
      source: "pi:openrouter",
      path: "/auth.json",
    });
  });

  it("reports 429 as rate_limited with the Retry-After hint", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "rate_limited", error: "provider_rate_limited" },
    });
    expect(report.state.retryAfter).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects a response body larger than the bounded limit", async () => {
    const report = await createOpenRouterAdapter({
      credential: () => ({
        status: "available",
        key: KEY,
        source: "env:OPENROUTER_API_KEY",
      }),
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": "999999999" },
        }),
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "unavailable",
      state: { status: "error", error: "response_too_large" },
    });
  });
});
