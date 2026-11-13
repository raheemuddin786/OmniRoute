/**
 * Certain providers gate specific models behind client harness, publisher agreement, or permission
 * (e.g. OpenRouter 403 "only available on agentic harnesses", ModelScope 401/403 invalid_model).
 * These errors report a MODEL denial, not a revoked or expired credential.
 * Scope this exception to known wire signatures; an ordinary 401/403 must still expire or cool credentials as usual.
 */
import { getM365FailureScope } from "../m365ErrorPolicy.ts";

const MODELSCOPE_MODEL_MESSAGE =
  /the model does not exist or you do not have access to it(?:[.!?\s]|$)/i;
const MODELSCOPE_JSON_CODE = /["']code["']\s*:\s*["']invalid_model["']/i;
const AGENTIC_HARNESS_GATED_MESSAGE =
  /\b(?:only available on agentic harnesses|agentic harnesses|openrouter\.ai\/apps)\b/i;
const INVALID_CREDENTIAL_MESSAGE =
  /\b(?:invalid|expired|revoked|missing)\s+(?:api[ -]?key|access[ -]?token|bearer[ -]?token)\b|\bauthentication expired\b/i;

export function isModelScopedAccessDenial(
  provider: string | null | undefined,
  status: number,
  errorText: unknown,
  structuredError?: { code?: unknown; message?: unknown } | null
): boolean {
  if (getM365FailureScope(provider, status, errorText, structuredError) === "model") return true;
  if (isOpenRouterHarnessAccessDenial(provider, status, errorText, structuredError)) return true;
  return isModelScopeAccessDenial(provider, status, errorText, structuredError);
}

function isOpenRouterHarnessAccessDenial(
  _provider: string | null | undefined,
  status: number,
  errorText: unknown,
  structuredError?: { code?: unknown; message?: unknown } | null
): boolean {
  if (status !== 403 && status !== 401) return false;
  let text = "";
  if (typeof errorText === "string") text = errorText;
  else {
    try {
      text = JSON.stringify(errorText ?? "");
    } catch {
      return false;
    }
  }
  const structuredMessage =
    typeof structuredError?.message === "string" ? structuredError.message : "";
  const combined = [text, structuredMessage].join(" ");
  if (INVALID_CREDENTIAL_MESSAGE.test(combined)) return false;
  return AGENTIC_HARNESS_GATED_MESSAGE.test(combined);
}

function isModelScopeAccessDenial(
  provider: string | null | undefined,
  status: number,
  errorText: unknown,
  structuredError?: { code?: unknown; message?: unknown } | null
): boolean {
  if (provider?.toLowerCase() !== "modelscope" || (status !== 401 && status !== 403)) {
    return false;
  }
  let text = "";
  if (typeof errorText === "string") text = errorText;
  else {
    try {
      text = JSON.stringify(errorText ?? "");
    } catch {
      return false;
    }
  }
  const structuredMessage =
    typeof structuredError?.message === "string" ? structuredError.message : "";
  if (INVALID_CREDENTIAL_MESSAGE.test([text, structuredMessage].join(" "))) return false;
  return (
    (typeof structuredError?.code === "string" &&
      structuredError.code.toLowerCase() === "invalid_model") ||
    MODELSCOPE_JSON_CODE.test(text) ||
    MODELSCOPE_MODEL_MESSAGE.test(text)
  );
}
