import {
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";
import { getAntigravityContentHeaders } from "./antigravityHeaders.ts";
import type { AntigravityCredentialsLike } from "./antigravityIdentity.ts";
import {
  resolveAntigravityCliVersion,
  resolveAntigravityIdeVersion,
} from "./antigravityVersion.ts";

export {
  ANTIGRAVITY_CLIENT_PROFILE_VALUES,
  DEFAULT_ANTIGRAVITY_CLIENT_PROFILE,
  normalizeAntigravityClientProfile,
  type AntigravityClientProfile,
} from "@/shared/constants/antigravityClientProfile";

type AntigravityProfileCredentials = AntigravityCredentialsLike & {
  providerSpecificData?: Record<string, unknown> | null;
};

const ABSENT_CONTENT_IDENTITY_HEADERS = [
  "x-client-name",
  "x-client-version",
  "x-machine-id",
  "x-vscode-sessionid",
  "X-Goog-Api-Client",
  "Client-Metadata",
] as const;

export function getAntigravityClientProfile(
  credentials?: AntigravityProfileCredentials | null
): AntigravityClientProfile {
  const fromProviderData =
    credentials?.providerSpecificData &&
    typeof credentials.providerSpecificData === "object" &&
    !Array.isArray(credentials.providerSpecificData)
      ? credentials.providerSpecificData.clientProfile
      : undefined;

  return normalizeAntigravityClientProfile(fromProviderData);
}

export function resolveAntigravityClientVersion(
  profile: AntigravityClientProfile
): Promise<string> {
  return profile === "cli" ? resolveAntigravityCliVersion() : resolveAntigravityIdeVersion();
}

export function removeHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      delete headers[key];
    }
  }
}

// Cache of account keys that have rejected x-goog-user-project with 403
// so we don't keep sending it and incurring the retry penalty.
const projectHeaderRejectedAccounts = new Set<string>();

function getProjectHeaderValue(body: unknown): string | null {
  const project =
    body && typeof body === "object" ? (body as Record<string, unknown>).project : null;
  if (typeof project !== "string" || project.trim().length === 0) return null;
  if (project === "test-project" || project === "project-id") return null;
  return project;
}

function getAccountKeyFromCredentials(
  credentials: AntigravityProfileCredentials | null | undefined
): string | null {
  if (!credentials) return null;
  return (
    credentials.email ||
    (credentials.providerSpecificData?.email as string) ||
    (credentials.providerSpecificData?.accountId as string) ||
    credentials.connectionId ||
    credentials.projectId ||
    null
  );
}

/** Apply the selected official client identity to a Cloud Code content request. */
export function applyAntigravityClientProfileHeaders(
  headers: Record<string, string>,
  credentials: AntigravityProfileCredentials | null | undefined,
  body: unknown
): AntigravityClientProfile {
  const profile = getAntigravityClientProfile(credentials);
  const identityHeaders = getAntigravityContentHeaders(profile);

  removeHeaderCaseInsensitive(headers, "User-Agent");
  headers["User-Agent"] = identityHeaders["User-Agent"];
  for (const name of ABSENT_CONTENT_IDENTITY_HEADERS) {
    removeHeaderCaseInsensitive(headers, name);
  }

  const accountKey = getAccountKeyFromCredentials(credentials);
  const project = getProjectHeaderValue(body);

  // Remove the header first (in case it was set by upstream)
  removeHeaderCaseInsensitive(headers, "x-goog-user-project");

  // Only add x-goog-user-project if:
  // 1. There's a valid project value from the request body
  // 2. This account hasn't previously rejected the header with 403
  if (project && accountKey && !projectHeaderRejectedAccounts.has(accountKey)) {
    headers["x-goog-user-project"] = project;
  }

  return profile;
}

/** Mark an account as having rejected x-goog-user-project with 403.
 * Subsequent requests for this account will skip sending the header. */
export function markProjectHeaderRejected(
  credentials: AntigravityProfileCredentials | null | undefined
): void {
  const accountKey = getAccountKeyFromCredentials(credentials);
  if (accountKey) {
    projectHeaderRejectedAccounts.add(accountKey);
  }
}

/** Check if an account has previously rejected x-goog-user-project. */
export function hasProjectHeaderBeenRejected(
  credentials: AntigravityProfileCredentials | null | undefined
): boolean {
  const accountKey = getAccountKeyFromCredentials(credentials);
  return accountKey ? projectHeaderRejectedAccounts.has(accountKey) : false;
}
