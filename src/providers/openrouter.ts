import { deleteCachedProvider as deleteCachedProviderFromDisk } from "../cache.js";
import { providerFetch } from "../lib/http.js";
import type {
  AuthProviderReport,
  OpenRouterCredits,
  OpenRouterFreeModelRequests,
  OpenRouterUsage,
  ProviderAdapter,
  ProviderOpenRouter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";
import {
  credentialCandidates,
  type EnvPiCredentialResolution,
  type EnvPiCredentialSources,
  errorCode,
  extractPiKeyCredential,
  inspectEnvPiAuth,
  KeyEndpointError,
  type KeyCredentialFailure,
  keyCredentialFailure,
  preferCredentialFailure,
  preferRemoteAuthFailure,
  requestKeyEndpoint,
  resolveEnvPiCredentials,
  statusFromRequestError,
} from "./env-pi-credential.js";

export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
export const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
export const OPENROUTER_PI_SOURCE = "pi:openrouter";
export const OPENROUTER_ENV_SOURCE = "env:OPENROUTER_API_KEY";

const LABEL = "OpenRouter";
const DEADLINE_MS = 15_000;

const OPENROUTER_SOURCES: EnvPiCredentialSources = {
  envVar: "OPENROUTER_API_KEY",
  envSource: OPENROUTER_ENV_SOURCE,
  piProviderId: "openrouter",
  piSource: OPENROUTER_PI_SOURCE,
};

type Dependencies = {
  credential: () => EnvPiCredentialResolution | EnvPiCredentialResolution[];
  fetch: typeof providerFetch;
  deleteCachedProvider: typeof deleteCachedProviderFromDisk;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedOpenRouterPayload = {
  label?: string;
  limit?: number;
  remaining?: number;
  period?: string;
  unlimited: boolean;
  /** Spend the key has drawn, in USD, over each of the vendor's own windows. */
  usage?: OpenRouterUsage;
  freeModelRequests?: OpenRouterFreeModelRequests;
};

/** The credits endpoint's two figures, in USD. */
export type NormalizedOpenRouterCredits = {
  bought: number;
  used: number;
};

export function resolveOpenRouterCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path?: string,
): EnvPiCredentialResolution[] {
  return resolveEnvPiCredentials(OPENROUTER_SOURCES, environment, path);
}

export function extractOpenRouterCredential(
  value: unknown,
  path: string,
): EnvPiCredentialResolution {
  return extractPiKeyCredential(
    value,
    "openrouter",
    OPENROUTER_PI_SOURCE,
    path,
  );
}

export function createOpenRouterAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveOpenRouterCredentials(),
    fetch: providerFetch,
    deleteCachedProvider: deleteCachedProviderFromDisk,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "openrouter",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const openrouterAdapter = createOpenRouterAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalFailure: KeyCredentialFailure | undefined;
  for (const resolution of credentialCandidates(dependencies.credential)) {
    if (resolution.status !== "available") {
      const failure = keyCredentialFailure("openrouter", resolution);
      attempts.push({
        source: resolution.source,
        status: resolution.status === "missing" ? "skipped" : "failed",
        error: failure.error,
      });
      finalFailure = preferCredentialFailure(finalFailure, failure);
      continue;
    }

    try {
      const payload = await requestKeyEndpoint(
        OPENROUTER_KEY_URL,
        resolution.key,
        dependencies.fetch,
        dependencies.deadlineMs,
      );
      const normalized = normalizeOpenRouterPayload(payload);
      const credits = await readCredits(dependencies, resolution.key);
      attempts.push({ source: resolution.source, status: "success" });

      const windows: QuotaWindow[] = [];
      if (
        !normalized.unlimited &&
        normalized.limit !== undefined &&
        normalized.remaining !== undefined
      ) {
        const used = Math.max(0, normalized.limit - normalized.remaining);
        const percentRemaining =
          normalized.limit > 0
            ? clampPercent(100 - (used / normalized.limit) * 100)
            : normalized.remaining <= 0
              ? 0
              : undefined;
        if (percentRemaining !== undefined) {
          windows.push({
            id: "key-limit",
            label: "Key spend cap",
            kind: "credits",
            spentUsd: used,
            limitUsd: normalized.limit,
            percentRemaining,
            ...(normalized.period ? { resetText: normalized.period } : {}),
          });
        }
      }

      return successProvider({
        provider: "openrouter",
        label: LABEL,
        source: "api",
        account: normalized.label
          ? { accountId: normalized.label, identityStatus: "unverified" }
          : undefined,
        windows,
        ...(normalized.unlimited
          ? { credits: { unlimited: true, unit: "usd" } }
          : normalized.remaining !== undefined
            ? { credits: { remaining: normalized.remaining, unit: "usd" } }
            : {}),
        ...openRouterFigures(normalized, credits),
        refreshedAt: new Date(dependencies.now()).toISOString(),
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      const code = errorCode(error);
      attempts.push({
        source: resolution.source,
        status: "failed",
        error: code,
      });
      if (code === "provider_auth_rejected") {
        finalFailure = preferRemoteAuthFailure(finalFailure, code);
        continue;
      }
      return failedProvider({
        provider: "openrouter",
        label: LABEL,
        status: statusFromRequestError(code),
        error: code,
        source: "unavailable",
        retryAfter:
          error instanceof KeyEndpointError ? error.retryAfter : undefined,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
  }

  const failure = finalFailure ?? {
    status: "auth_required" as const,
    error: "openrouter_credential_unavailable",
  };
  if (failure.status === "auth_required") {
    try {
      dependencies.deleteCachedProvider("openrouter");
    } catch {
      // Preserve the current definitive auth result.
    }
  }
  return failedProvider({
    provider: "openrouter",
    label: LABEL,
    status: failure.status,
    error: failure.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  return inspectEnvPiAuth(
    "openrouter",
    credentialCandidates(dependencies.credential),
  );
}

/**
 * The credits endpoint, read with the same bearer that just answered for the
 * key. It is a second, independent request for figures that sit beside the
 * quota reading rather than inside it, so a failure here costs those figures
 * their lines and nothing else: the provider still reports whatever the key
 * endpoint said.
 */
async function readCredits(
  dependencies: Dependencies,
  key: string,
): Promise<NormalizedOpenRouterCredits | undefined> {
  try {
    const payload = await requestKeyEndpoint(
      OPENROUTER_CREDITS_URL,
      key,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    return normalizeOpenRouterCredits(payload);
  } catch {
    return undefined;
  }
}

/**
 * The vendor's own figures, in the currency it reported them in. Each group is
 * published only when it is complete: a half-read usage row would be rendered
 * as a real figure, and a missing window is not a zero one.
 */
function openRouterFigures(
  normalized: NormalizedOpenRouterPayload,
  credits: NormalizedOpenRouterCredits | undefined,
): { openrouter?: ProviderOpenRouter } {
  const figures: ProviderOpenRouter = {
    ...(credits ? { creditsUsd: creditsWithRemaining(credits) } : {}),
    ...(normalized.usage ? { usageUsd: normalized.usage } : {}),
    ...(normalized.freeModelRequests
      ? { freeModelRequests: normalized.freeModelRequests }
      : {}),
  };
  return Object.keys(figures).length === 0 ? {} : { openrouter: figures };
}

/** What is left of the credits bought; negative when the account is overdrawn. */
function creditsWithRemaining(
  credits: NormalizedOpenRouterCredits,
): OpenRouterCredits {
  return {
    bought: credits.bought,
    used: credits.used,
    remaining: credits.bought - credits.used,
  };
}

export function normalizeOpenRouterCredits(
  raw: unknown,
): NormalizedOpenRouterCredits | undefined {
  const data = objectValue(objectValue(raw)?.data);
  if (!data) return undefined;
  const bought = asFiniteNumber(data.total_credits);
  const used = asFiniteNumber(data.total_usage);
  if (bought === undefined || used === undefined) return undefined;
  return { bought, used };
}

export function normalizeOpenRouterPayload(
  raw: unknown,
): NormalizedOpenRouterPayload {
  const root = objectValue(raw);
  if (!root) throw new Error("invalid_payload");
  const data = objectValue(root.data);
  if (!data) throw new Error("missing_data");

  const unlimited = data.limit === null;
  const limit = unlimited ? undefined : asNonnegativeNumber(data.limit);
  if (!unlimited && limit === undefined) throw new Error("invalid_limit");
  const remaining = asFiniteNumber(data.limit_remaining);
  const period = asString(data.limit_reset);
  const label = asString(data.label);
  const usage = normalizeUsage(data);
  const freeModelRequests = normalizeFreeModelRequests(
    data.free_model_daily_requests,
  );

  return {
    label,
    limit,
    remaining,
    period,
    unlimited,
    ...(usage ? { usage } : {}),
    ...(freeModelRequests ? { freeModelRequests } : {}),
  };
}

/** All four windows or none: a partial row would read as a measured zero. */
function normalizeUsage(
  data: Record<string, unknown>,
): OpenRouterUsage | undefined {
  const allTime = asFiniteNumber(data.usage);
  const today = asFiniteNumber(data.usage_daily);
  const week = asFiniteNumber(data.usage_weekly);
  const month = asFiniteNumber(data.usage_monthly);
  if (
    allTime === undefined ||
    today === undefined ||
    week === undefined ||
    month === undefined
  )
    return undefined;
  return { allTime, today, week, month };
}

function normalizeFreeModelRequests(
  value: unknown,
): OpenRouterFreeModelRequests | undefined {
  const data = objectValue(value);
  if (!data) return undefined;
  const used = asNonnegativeNumber(data.used);
  const limit = asNonnegativeNumber(data.limit);
  const remaining = asNonnegativeNumber(data.remaining);
  if (used === undefined || limit === undefined || remaining === undefined)
    return undefined;
  return { used, limit, remaining };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.trim();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
