import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateParent, readJsonFile } from "../lib/fs.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderAws,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

/**
 * Box-dashboard fork: what this EC2 box has cost since it booted - hours since
 * boot times this instance size's on-demand rate.
 *
 * It replaces a Cost Explorer month-to-date read (MT-29, lag bug MT-31): that
 * needed a billing-ro IAM credential, cost $0.01 a call, lagged about a day,
 * and sat at $0.00 for hours after real spend was already showing in the
 * console. This is local arithmetic instead - boot time from `/proc/uptime` and
 * instance size from this box's own IMDSv2 endpoint, both instance-local - so
 * it is exact and free on every render (MT-34). It deliberately does not track
 * spend from before this boot: starting the box resets it to zero, because the
 * point is what THIS session has cost so far, to make an overnight-left-on box
 * visibly expensive rather than to reproduce the console's monthly total.
 *
 * It is session cost, not the invoice. No credential, no AWS SDK, no Cost
 * Explorer, and no figure that outlives the boot it was measured against.
 */

const LABEL = "AWS";
export const AWS_REGION = "ap-southeast-2";
export const AWS_IMDS_SOURCE = "imds";

const IMDS_TOKEN_URL = "http://169.254.169.254/latest/api/token";
const IMDS_INSTANCE_TYPE_URL =
  "http://169.254.169.254/latest/meta-data/instance-type";
const IMDS_TIMEOUT_MS = 2_000;
const IMDS_TOKEN_TTL_SECONDS = "60";
/** IMDS answers in a dozen bytes; anything larger is not this endpoint. */
const MAX_IMDS_BYTES = 256;
/** `t3.medium`, `m5.4xlarge`: the vendor's own instance-type spelling. */
const INSTANCE_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,15}\.[a-z0-9]{1,15}$/;

/** The cached answer for a box IMDS did not answer for on this boot. */
const NO_IMDS = "no-imds";

/**
 * Rate table: ap-southeast-2 (Sydney) on-demand, USD per hour, t3 family only -
 * the family this box runs. Cross-checked 2026-08-07 against two independently
 * sourced rates (t3.micro $0.0132/h, t3.2xlarge $0.4224/h) that both land on
 * the same ~1.265x multiplier over AWS's published us-east-1 base rates; that
 * same multiplier reproduces MT-34's own t3.xlarge $0.2112/h figure exactly.
 *
 * There is deliberately no fallback query for a size that is missing - that
 * would reintroduce the Cost Explorer lag and per-call cost this replaced. Add
 * the size here instead. The table goes stale if AWS reprices the region or the
 * box moves off the t3 family.
 */
export const AWS_RATE_PER_HOUR_USD: Readonly<Record<string, number>> = {
  "t3.nano": 0.0066,
  "t3.micro": 0.0132,
  "t3.small": 0.0264,
  "t3.medium": 0.0528,
  "t3.large": 0.1056,
  "t3.xlarge": 0.2112,
  "t3.2xlarge": 0.4224,
};

/**
 * The instance size cannot change while the box is up (this box only resizes
 * stopped), so it is cached against the boot epoch rather than re-queried on
 * every render. A boot epoch more than this far from the cached one - a reboot,
 * or a stopped resize - invalidates the cache; the slack absorbs
 * `/proc/uptime`'s own jitter.
 */
const BOOT_EPOCH_SLACK_SECONDS = 60;

export type AwsInstanceCache = {
  /** Unix seconds this box booted at, derived from uptime. */
  bootEpoch: number;
  /** The instance type IMDS named, or `no-imds` when it did not answer. */
  instanceType: string;
};

type Dependencies = {
  /** Whole seconds since boot, or undefined when uptime cannot be read. */
  readUptimeSeconds: () => number | undefined;
  request: (url: string, init: RequestInit) => Promise<Response>;
  cachePath: () => string;
  /**
   * `off` skips the probe and its cache write entirely, the way
   * `QUOTA_AXI_CCUSAGE=off` skips the ccusage subprocess. A run that never
   * asked the endpoint records nothing about this boot either way.
   */
  imdsEnabled: () => boolean;
  now: () => number;
  timeoutMs: number;
};

export function awsInstanceCachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "quota-axi", "aws-instance.json");
}

export function createAwsAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    readUptimeSeconds,
    // Deliberately not `providerFetch`: 169.254.169.254 is a link-local address
    // served by this instance itself, so sending it through the host's
    // configured HTTP proxy would ask an unrelated host for this box's
    // metadata. Antigravity's loopback probe stays off the proxy path for the
    // same reason.
    request: (url, init) => fetch(url, init),
    cachePath: awsInstanceCachePath,
    imdsEnabled: () => process.env.QUOTA_AXI_AWS_IMDS !== "off",
    now: Date.now,
    timeoutMs: IMDS_TIMEOUT_MS,
    ...overrides,
  };
  return {
    id: "aws",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(),
  };
}

export const awsAdapter = createAwsAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const uptimeSeconds = dependencies.readUptimeSeconds();
  if (uptimeSeconds === undefined) {
    // A session cost needs a session length. Reporting the shell's zero-uptime
    // fallback here would print $0.00, which reads as a measured "nothing spent
    // yet" rather than as an unread input.
    return unavailable("no-uptime", [
      { source: AWS_IMDS_SOURCE, status: "skipped", error: "no-uptime" },
    ]);
  }

  const bootEpoch = Math.round(dependencies.now() / 1000) - uptimeSeconds;
  let instanceType = readInstanceCache(dependencies.cachePath(), bootEpoch);
  if (instanceType === undefined && dependencies.imdsEnabled()) {
    // A failed probe still gets cached against this boot, so a box IMDS does
    // not answer for pays the timeout once per boot rather than every render.
    instanceType = (await probeInstanceType(dependencies)) ?? NO_IMDS;
    writeInstanceCache(dependencies.cachePath(), { bootEpoch, instanceType });
  }
  instanceType ??= NO_IMDS;
  const answered = instanceType !== NO_IMDS;
  const attempts: SourceAttempt[] = [
    {
      source: AWS_IMDS_SOURCE,
      status: answered ? "success" : "failed",
      ...(answered ? {} : { error: NO_IMDS }),
    },
  ];

  if (!answered) return unavailable(NO_IMDS, attempts);

  const ratePerHourUsd = AWS_RATE_PER_HOUR_USD[instanceType];
  if (ratePerHourUsd === undefined) {
    return unavailable(`no-rate (${instanceType})`, attempts);
  }

  const uptimeHours = uptimeSeconds / 3600;
  const aws: ProviderAws = {
    instanceType,
    region: AWS_REGION,
    ratePerHourUsd,
    uptimeHours: round4(uptimeHours),
    sessionUsd: round4(uptimeHours * ratePerHourUsd),
  };
  return successProvider({
    provider: "aws",
    label: LABEL,
    source: AWS_IMDS_SOURCE,
    plan: instanceType,
    // Session cost is not a quota window and bounds nothing: this box can keep
    // running past any figure it reports.
    windows: [],
    aws,
    refreshedAt: new Date(dependencies.now()).toISOString(),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

function unavailable(error: string, attempts: SourceAttempt[]): ProviderQuota {
  return failedProvider({
    provider: "aws",
    label: LABEL,
    status: "unavailable",
    error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

/** No credential reaches this provider, so there is no auth source to inspect. */
async function inspectAuth(): Promise<AuthProviderReport> {
  return { provider: "aws", sources: [] };
}

/**
 * The IMDSv2 handshake: a short-lived token, then the instance type read with
 * it. Every failure - not on EC2, no route, a hostile answer - resolves as
 * undefined rather than throwing, because a box that is not an EC2 instance is
 * a normal reading of this provider, not an error in it.
 */
async function probeInstanceType(
  dependencies: Dependencies,
): Promise<string | undefined> {
  const token = await requestText(dependencies, IMDS_TOKEN_URL, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": IMDS_TOKEN_TTL_SECONDS },
  });
  if (!token) return undefined;
  const instanceType = await requestText(dependencies, IMDS_INSTANCE_TYPE_URL, {
    headers: { "X-aws-ec2-metadata-token": token },
  });
  if (!instanceType || !INSTANCE_TYPE_PATTERN.test(instanceType))
    return undefined;
  return instanceType;
}

async function requestText(
  dependencies: Dependencies,
  url: string,
  init: RequestInit,
): Promise<string | undefined> {
  try {
    const response = await dependencies.request(url, {
      ...init,
      signal: AbortSignal.timeout(dependencies.timeoutMs),
    });
    if (!response.ok) return undefined;
    const text = await readBoundedText(response);
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Read at most one IMDS answer's worth; a larger body is discarded whole. */
async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length <= MAX_IMDS_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      length += value.byteLength;
      chunks.push(value);
    }
  } catch {
    return "";
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (length > MAX_IMDS_BYTES) return "";
  return Buffer.concat(chunks).toString("utf8").trim();
}

function readUptimeSeconds(): number | undefined {
  try {
    const first = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
    const seconds = Number(first);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.floor(seconds);
  } catch {
    return undefined;
  }
}

/**
 * The cached instance type, when it was recorded against this same boot. A
 * cache written before a reboot describes a machine that no longer exists, so
 * it is ignored rather than corrected.
 */
export function readInstanceCache(
  path: string,
  bootEpoch: number,
): string | undefined {
  const value = readJsonFile(path);
  if (!isRecord(value)) return undefined;
  const cachedBoot = value.bootEpoch;
  const instanceType = value.instanceType;
  if (typeof cachedBoot !== "number" || !Number.isFinite(cachedBoot))
    return undefined;
  if (typeof instanceType !== "string" || instanceType === "") return undefined;
  if (Math.abs(bootEpoch - cachedBoot) > BOOT_EPOCH_SLACK_SECONDS)
    return undefined;
  return instanceType;
}

/**
 * Write through a temporary file, as the quota cache does, so a render
 * interrupted mid-write leaves no half-written line behind. A cache that cannot
 * be written only costs the next render another probe.
 */
export function writeInstanceCache(
  path: string,
  entry: AwsInstanceCache,
): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    ensurePrivateParent(path);
    writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch {
    // The next render pays one more probe; nothing else depends on this file.
  }
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
