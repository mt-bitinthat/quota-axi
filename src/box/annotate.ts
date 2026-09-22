import {
  peekCcusage,
  primeCcusage,
  resolveCcusage,
  SPEND_WINDOW_DAYS,
  type SpendDeps,
  type SpendResult,
} from "../spend/ccusage.js";
import type {
  ProviderId,
  ProviderQuota,
  ProviderSpend,
  QuotaAxiResponse,
} from "../types.js";
import { readBoxConfig, type BoxConfig } from "./config.js";
import { nextRenewal } from "./subscription.js";

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

export type BoxAnnotationOptions = {
  /**
   * Whether to wait for the ccusage window. The one-shot machine surfaces wait,
   * because they have no second frame to fill the figure in on; the TUI never
   * does, and shows the pending line until a later refresh picks it up.
   */
  awaitSpend: boolean;
  now?: Date;
  configPath?: string;
  spendDeps?: SpendDeps;
};

/** Whether any of these providers owns a spend bucket, and so a spend line. */
export function boxSpendApplies(providers: readonly ProviderId[]): boolean {
  return providers.some((provider) => SPEND_BUCKET[provider] !== undefined);
}

/**
 * Start the ccusage window so it runs alongside the provider fetches. A report
 * that asked for no card with a spend line spawns nothing: the subprocess is
 * only ever worth its latency when a card would show the figure.
 */
export function primeBoxSpend(
  providers: readonly ProviderId[],
  deps: SpendDeps = {},
): void {
  if (!boxSpendApplies(providers)) return;
  primeCcusage(deps);
}

export async function annotateBoxLines(
  response: QuotaAxiResponse,
  options: BoxAnnotationOptions,
): Promise<QuotaAxiResponse> {
  const now = options.now ?? new Date();
  const config = readBoxConfig(options.configPath);
  const deps = options.spendDeps ?? {};
  const providers = response.providers.map((provider) => provider.provider);
  const spend: SpendResult = !boxSpendApplies(providers)
    ? { status: "pending" }
    : options.awaitSpend
      ? await resolveCcusage(deps)
      : peekCcusage(deps);
  return {
    ...response,
    providers: response.providers.map((provider) =>
      annotateProvider(provider, config, spend, now),
    ),
  };
}

function annotateProvider(
  provider: ProviderQuota,
  config: BoxConfig | undefined,
  spend: SpendResult,
  now: Date,
): ProviderQuota {
  const entry = config?.subscriptions[provider.provider];
  const subscription = entry ? nextRenewal(entry, now) : undefined;
  const bucket = SPEND_BUCKET[provider.provider];
  const spendField =
    bucket === undefined
      ? undefined
      : providerSpend(spend, bucket, config?.fx?.audPerUsd);
  if (subscription === undefined && spendField === undefined) return provider;
  return {
    ...provider,
    ...(subscription ? { subscription } : {}),
    ...(spendField ? { spend: spendField } : {}),
  };
}

function providerSpend(
  spend: SpendResult,
  bucket: "claude" | "other",
  audPerUsd: number | undefined,
): ProviderSpend {
  const base = {
    windowDays: SPEND_WINDOW_DAYS,
    source: "ccusage" as const,
  };
  if (spend.status !== "measured") return { ...base, status: spend.status };
  const usd =
    bucket === "claude"
      ? spend.reading.buckets.claudeUsd
      : spend.reading.buckets.otherUsd;
  return {
    ...base,
    status: "measured",
    usd: round2(usd),
    // Without a rate the figure stays in the currency it was priced in rather
    // than being converted at a guess; the card labels it USD.
    ...(audPerUsd === undefined ? {} : { aud: round2(usd * audPerUsd) }),
    refreshedAt: spend.reading.refreshedAt,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
