import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AWS_RATE_PER_HOUR_USD,
  awsInstanceCachePath,
  createAwsAdapter,
} from "../../src/providers/aws.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const NOW_MS = Date.parse("2026-09-22T06:00:00.000Z");
const TOKEN_URL = "http://169.254.169.254/latest/api/token";
const TYPE_URL = "http://169.254.169.254/latest/meta-data/instance-type";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function cacheFile(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-aws-"));
  return join(tempDir, "aws-instance.json");
}

/** An IMDSv2 responder: a token on PUT, then the instance type it unlocks. */
function imds(instanceType: string, token = "synthetic-imds-token") {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url === TOKEN_URL) {
      expect(init.method).toBe("PUT");
      expect(
        (init.headers as Record<string, string>)[
          "X-aws-ec2-metadata-token-ttl-seconds"
        ],
      ).toBe("60");
      return new Response(token);
    }
    expect(url).toBe(TYPE_URL);
    expect(
      (init.headers as Record<string, string>)["X-aws-ec2-metadata-token"],
    ).toBe(token);
    return new Response(instanceType);
  });
}

function adapter(
  overrides: {
    uptimeSeconds?: number | undefined;
    request?: (url: string, init: RequestInit) => Promise<Response>;
    path?: string;
    nowMs?: number;
  } = {},
) {
  const path = overrides.path ?? cacheFile();
  return createAwsAdapter({
    readUptimeSeconds: () =>
      "uptimeSeconds" in overrides ? overrides.uptimeSeconds : 10 * 3600,
    request: overrides.request ?? imds("t3.medium"),
    cachePath: () => path,
    imdsEnabled: () => true,
    now: () => overrides.nowMs ?? NOW_MS,
  });
}

describe("AWS session cost provider", () => {
  it("bills the hours since boot at this instance type's on-demand rate", async () => {
    const request = imds("t3.medium");
    const report = await adapter({ request }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "aws",
      source: "imds",
      plan: "t3.medium",
      windows: [],
      state: { status: "fresh", stale: false },
      attempts: [{ source: "imds", status: "success" }],
      aws: {
        instanceType: "t3.medium",
        region: "ap-southeast-2",
        ratePerHourUsd: 0.0528,
        uptimeHours: 10,
        sessionUsd: 0.528,
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("prices every size in the table off its own rate", async () => {
    for (const [instanceType, rate] of Object.entries(AWS_RATE_PER_HOUR_USD)) {
      const report = await adapter({
        request: imds(instanceType),
        uptimeSeconds: 3600,
      }).fetchQuota(OPTIONS);
      expect(report.aws?.sessionUsd).toBeCloseTo(rate, 10);
    }
  });

  it("reports no-rate for a size the table does not price", async () => {
    const report = await adapter({ request: imds("m5.4xlarge") }).fetchQuota(
      OPTIONS,
    );

    expect(report.state.status).toBe("unavailable");
    expect(report.state.error).toBe("no-rate (m5.4xlarge)");
    expect(report.aws).toBeUndefined();
  });

  it("reports no-imds when the endpoint times out, and caches it for this boot", async () => {
    const path = cacheFile();
    const request = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const report = await adapter({ request, path }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("unavailable");
    expect(report.state.error).toBe("no-imds");
    expect(report.attempts).toEqual([
      { source: "imds", status: "failed", error: "no-imds" },
    ]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      bootEpoch: NOW_MS / 1000 - 10 * 3600,
      instanceType: "no-imds",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A second read on the same boot answers from the cache: a box IMDS does
    // not serve pays the timeout once, not on every render.
    const again = await adapter({ request, path }).fetchQuota(OPTIONS);
    expect(again.state.error).toBe("no-imds");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("answers a later read on the same boot from the cache", async () => {
    const path = cacheFile();
    const request = imds("t3.large");
    await adapter({ request, path }).fetchQuota(OPTIONS);
    // An hour later, with an hour more uptime: the same boot, so the same cache.
    const second = await adapter({
      request,
      path,
      uptimeSeconds: 11 * 3600,
      nowMs: NOW_MS + 3_600_000,
    }).fetchQuota(OPTIONS);

    // The cached type is reused, but the cost is recomputed from live uptime.
    expect(request).toHaveBeenCalledTimes(2);
    expect(second.aws).toMatchObject({
      instanceType: "t3.large",
      uptimeHours: 11,
      sessionUsd: 1.1616,
    });
  });

  it("keeps the cache across a boot epoch 60 seconds adrift", async () => {
    const path = cacheFile();
    const request = imds("t3.small");
    await adapter({ request, path }).fetchQuota(OPTIONS);

    const report = await adapter({
      request,
      path,
      uptimeSeconds: 10 * 3600 + 60,
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(2);
    expect(report.aws?.instanceType).toBe("t3.small");
  });

  it("re-probes when the boot epoch is 61 seconds adrift", async () => {
    const path = cacheFile();
    const first = imds("t3.small");
    await adapter({ request: first, path }).fetchQuota(OPTIONS);

    const second = imds("t3.xlarge");
    const report = await adapter({
      request: second,
      path,
      uptimeSeconds: 10 * 3600 + 61,
    }).fetchQuota(OPTIONS);

    expect(second).toHaveBeenCalledTimes(2);
    expect(report.aws?.instanceType).toBe("t3.xlarge");
  });

  it("reports no-uptime rather than a measured zero when uptime is unreadable", async () => {
    const request = imds("t3.medium");
    const report = await adapter({
      request,
      uptimeSeconds: undefined,
    }).fetchQuota(OPTIONS);

    expect(report.state.status).toBe("unavailable");
    expect(report.state.error).toBe("no-uptime");
    expect(request).not.toHaveBeenCalled();
  });

  it("probes nothing and writes nothing when the probe is switched off", async () => {
    const path = cacheFile();
    const request = imds("t3.medium");
    const report = await createAwsAdapter({
      readUptimeSeconds: () => 3600,
      request,
      cachePath: () => path,
      imdsEnabled: () => false,
      now: () => NOW_MS,
    }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("no-imds");
    expect(request).not.toHaveBeenCalled();
    expect(() => readFileSync(path, "utf8")).toThrow();
  });

  it("discards an answer that is not an instance type", async () => {
    const request = vi.fn(async (url: string) =>
      url === TOKEN_URL
        ? new Response("synthetic-imds-token")
        : new Response("<html>not metadata</html>"),
    );
    const report = await adapter({ request }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("no-imds");
  });

  it("treats an IMDS error status as no answer", async () => {
    const request = vi.fn(async (url: string) =>
      url === TOKEN_URL
        ? new Response("synthetic-imds-token")
        : new Response("denied", { status: 403 }),
    );
    const report = await adapter({ request }).fetchQuota(OPTIONS);

    expect(report.state.error).toBe("no-imds");
  });

  it("has no credential source to inspect", async () => {
    const report = await adapter().inspectAuth(OPTIONS);
    expect(report).toEqual({ provider: "aws", sources: [] });
  });

  it("keeps the instance cache beside the quota cache", () => {
    const previous = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = "/synthetic/cache";
    try {
      expect(awsInstanceCachePath()).toBe(
        "/synthetic/cache/quota-axi/aws-instance.json",
      );
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });
});
