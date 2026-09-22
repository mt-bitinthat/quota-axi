import {
  peekCcusage,
  primeCcusage,
  resolveCcusage,
  spendBucketsSince,
  SPEND_WINDOW_DAYS,
  type SpendDeps,
  type SpendResult,
} from "../spend/ccusage.js";
import type {
  OpenRouterCredits,
  OpenRouterUsage,
  ProviderAws,
  ProviderId,
  ProviderOpenRouter,
  ProviderQuota,
  ProviderSpend,
  QuotaAxiResponse,
} from "../types.js";
import { readBoxConfig, type BoxConfig } from "./config.js";
import {
  lastRenewal,
  nextRenewal,
  rollingCycle,
  type SpendCycle,
} from "./subscription.js";

/**
 * Box-dashboard fork: attach the two operator-facing money lines to the report.
 *
 * Both are local facts rendered beside the reading, so this runs after the
 * providers have answered and after the quota cache has been written - nothing
 * here can reach a provider, change a window, or be persisted as a snapshot.
 */

/** Which ccusage bucket each card owns. Claude's models, then everything else. */
const SPEND_BUCKET: Partial<Record<ProviderId, "claude" | "other">> = {
  claude: "claude",
  codex: "other",
};

export type BoxSpendOptions = {
  now?: Date;
  configPath?: string;
  spendDeps?: SpendDeps;
};

export type BoxAnnotationOptions = BoxSpendOptions & {
  /**
   * Whether to wait for the ccusage window. The one-shot machine surfaces wait,
   * because they have no second frame to fill the figure in on; the TUI never
   * does, and shows the pending line until a later refresh picks it up.
   */
  awaitSpend: boolean;
};

/** Whether any of these providers owns a spend bucket, and so a spend line. */
export function boxSpendApplies(providers: readonly ProviderId[]): boolean {
  return providers.some((provider) => SPEND_BUCKET[provider] !== undefined);
}

/**
 * Start the ccusage run so it happens alongside the provider fetches. A report
 * that asked for no card with a spend line spawns nothing: the subprocess is
 * only ever worth its latency when a card would show the figure.
 */
export function primeBoxSpend(
  providers: readonly ProviderId[],
  options: BoxSpendOptions = {},
): void {
  if (!boxSpendApplies(providers)) return;
  const now = options.now ?? new Date();
  const cycles = spendCycles(providers, readBoxConfig(options.configPath), now);
  primeCcusage(earliestSince(cycles), options.spendDeps ?? {});
}

export async function annotateBoxLines(
  response: QuotaAxiResponse,
  options: BoxAnnotationOptions,
): Promise<QuotaAxiResponse> {
  const now = options.now ?? new Date();
  const config = readBoxConfig(options.configPath);
  const deps = options.spendDeps ?? {};
  const providers = response.providers.map((provider) => provider.provider);
  const cycles = spendCycles(providers, config, now);
  const since = earliestSince(cycles);
  const spend: SpendResult = !boxSpendApplies(providers)
    ? { status: "pending" }
    : options.awaitSpend
      ? await resolveCcusage(since, deps)
      : peekCcusage(since, deps);
  return {
    ...response,
    providers: response.providers.map((provider) =>
      annotateProvider(provider, config, cycles, spend, now),
    ),
  };
}

/**
 * The window each card's figure covers: the billing cycle it is inside, or the
 * rolling fallback for a card this box has no subscription entry for. A card
 * always has a window, so a missing `box.json` costs the figure its cycle, not
 * its line.
 */
function spendCycles(
  providers: readonly ProviderId[],
  config: BoxConfig | undefined,
  now: Date,
): Map<ProviderId, SpendCycle> {
  const fallback = rollingCycle(now, SPEND_WINDOW_DAYS);
  const cycles = new Map<ProviderId, SpendCycle>();
  for (const provider of providers) {
    if (SPEND_BUCKET[provider] === undefined) continue;
    const entry = config?.subscriptions[provider];
    cycles.set(provider, (entry && lastRenewal(entry, now)) ?? fallback);
  }
  return cycles;
}

/**
 * How far back the single ccusage run has to reach to answer every card. Each
 * card then filters its own window out of the same priced days, so two cards
 * billed on different days of the month still cost one subprocess.
 */
function earliestSince(cycles: ReadonlyMap<ProviderId, SpendCycle>): string {
  let earliest: string | undefined;
  for (const cycle of cycles.values()) {
    if (earliest === undefined || cycle.since < earliest) {
      earliest = cycle.since;
    }
  }
  return earliest ?? rollingCycle(new Date(), SPEND_WINDOW_DAYS).since;
}

function annotateProvider(
  provider: ProviderQuota,
  config: BoxConfig | undefined,
  cycles: ReadonlyMap<ProviderId, SpendCycle>,
  spend: SpendResult,
  now: Date,
): ProviderQuota {
  const entry = config?.subscriptions[provider.provider];
  const subscription = entry
    ? nextRenewal(entry, now, config?.warnDays)
    : undefined;
  const bucket = SPEND_BUCKET[provider.provider];
  const cycle = cycles.get(provider.provider);
  const spendField =
    bucket === undefined || cycle === undefined
      ? undefined
      : providerSpend(
          spend,
          bucket,
          cycle,
          config?.fx?.audPerUsd,
          subscription?.amountAud,
        );
  const openrouter = openRouterAud(provider.openrouter, config?.fx?.audPerUsd);
  const aws = awsAud(provider.aws, config?.fx?.audPerUsd);
  if (
    subscription === undefined &&
    spendField === undefined &&
    openrouter === undefined &&
    aws === undefined
  )
    return provider;
  return {
    ...provider,
    ...(subscription ? { subscription } : {}),
    ...(spendField ? { spend: spendField } : {}),
    ...(openrouter ? { openrouter } : {}),
    ...(aws ? { aws } : {}),
  };
}

/**
 * The AUD half of this box's session cost. The arithmetic itself is in USD,
 * because that is the currency AWS prices the instance in, and the conversion
 * happens here for the same reason the OpenRouter one does: the rate is applied
 * fresh on every read rather than baked into the reading.
 *
 * The hourly rate keeps four decimals rather than two. A t3.nano costs under a
 * cent an hour, and rounding the rate to cents would round it away.
 */
function awsAud(
  figures: ProviderAws | undefined,
  audPerUsd: number | undefined,
): ProviderAws | undefined {
  if (!figures || audPerUsd === undefined) return figures;
  return {
    ...figures,
    sessionAud: round2(figures.sessionUsd * audPerUsd),
    ratePerHourAud: round4(figures.ratePerHourUsd * audPerUsd),
  };
}

/**
 * The AUD half of OpenRouter's own figures, mirroring the USD the provider
 * reported. Like the spend line, the conversion happens here rather than in the
 * adapter so the reading stays in the currency the vendor priced it in and the
 * rate is applied fresh every time the report is read.
 *
 * Without a configured rate the figures keep only their USD half, which is what
 * the card labels them as: converting at a guess would be a worse answer than
 * naming the currency.
 */
function openRouterAud(
  figures: ProviderOpenRouter | undefined,
  audPerUsd: number | undefined,
): ProviderOpenRouter | undefined {
  if (!figures || audPerUsd === undefined) return figures;
  return {
    ...figures,
    ...(figures.creditsUsd
      ? { creditsAud: convertCredits(figures.creditsUsd, audPerUsd) }
      : {}),
    ...(figures.usageUsd
      ? { usageAud: convertUsage(figures.usageUsd, audPerUsd) }
      : {}),
  };
}

function convertCredits(
  credits: OpenRouterCredits,
  audPerUsd: number,
): OpenRouterCredits {
  return {
    bought: round2(credits.bought * audPerUsd),
    used: round2(credits.used * audPerUsd),
    remaining: round2(credits.remaining * audPerUsd),
  };
}

function convertUsage(
  usage: OpenRouterUsage,
  audPerUsd: number,
): OpenRouterUsage {
  return {
    allTime: round2(usage.allTime * audPerUsd),
    today: round2(usage.today * audPerUsd),
    week: round2(usage.week * audPerUsd),
    month: round2(usage.month * audPerUsd),
  };
}

function providerSpend(
  spend: SpendResult,
  bucket: "claude" | "other",
  cycle: SpendCycle,
  audPerUsd: number | undefined,
  amountAud: number | undefined,
): ProviderSpend {
  const base = {
    windowDays: cycle.windowDays,
    since: cycle.since,
    source: "ccusage" as const,
  };
  if (spend.status !== "measured") return { ...base, status: spend.status };
  const buckets = spendBucketsSince(spend.reading, cycle.since);
  const usd = bucket === "claude" ? buckets.claudeUsd : buckets.otherUsd;
  // Without a rate the figure stays in the currency it was priced in rather
  // than being converted at a guess; the card labels it USD.
  const aud = audPerUsd === undefined ? undefined : round2(usd * audPerUsd);
  const ratio = spendRatio(aud, amountAud);
  return {
    ...base,
    status: "measured",
    usd: round2(usd),
    ...(aud === undefined ? {} : { aud }),
    ...(ratio === undefined ? {} : { ratio }),
    refreshedAt: spend.reading.refreshedAt,
  };
}

/**
 * How many times the subscription the same traffic would have cost at API list
 * prices. Both sides have to be in AUD for the comparison to mean anything, and
 * a free or unpriced plan has no multiple of itself, so either missing half
 * leaves the ratio off rather than filled in with something that reads as one.
 */
function spendRatio(
  aud: number | undefined,
  amountAud: number | undefined,
): number | undefined {
  if (aud === undefined || amountAud === undefined || amountAud === 0) {
    return undefined;
  }
  return Math.round((aud / amountAud) * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
