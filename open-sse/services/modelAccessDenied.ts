/**
 * KooshaPari's plan on #8251: one shared source for model-scoped 400s, so
 * combo dispatch and account fallback quote the same patterns.
 * HouMinXi: a wrapped "invalid" / "Bad Request" that is really "this model is
 * not on this account" advances. A different account may still serve it.
 */

export const MODEL_ACCESS_DENIED_PATTERNS = [
  /\binvalid model\b/i,
  /\bmodel.*not.*(?:available|found|supported|accessible)\b/i,
  /\bmodel.*(?:does not exist|doesn't exist)\b/i,
  /\bmodel\b[\s\S]{0,80}?\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b/i,
  /\b(?:does\s+not\s+support|doesn't\s+support|unsupported)\b[\s\S]{0,80}?\bmodel\b/i,
  /\bunsupported\s+model\b/i,
  /\baccess.*denied.*model\b/i,
  /\bmodel.*access.*denied\b/i,
  /\bplease select a different model\b/i,
  /\bunknown\s+provider\s+for\s+model\b/i,
  /\b(?:access|permission)[\s\S]{0,60}?\bmodel\b/i,
  /\bmodel[\s\S]{0,60}?\b(?:access|permission)\b/i,
  // Tool-calling & schema capabilities (model-specific)
  /\btools?\b[\s\S]{0,60}?\b(?:not\s+supported|unsupported)\b/i,
  /\b(?:not\s+supported|unsupported)\b[\s\S]{0,60}?\btools?\b/i,
  /\bfunction[_\s]call[\s\S]{0,60}?\b(?:not\s+supported|unsupported)\b/i,
  /\bmalformed[_\s]function[_\s]call\b/i,
  /\bparallel[_\s]tool[_\s]calls?\s+not\s+supported\b/i,
  // Reasoning & thinking transport capabilities (model-specific)
  /\breasoning[_\s]content\b/i,
  /\bthought[_\s]signature\b/i,
  /\bthinking\s+(?:is\s+)?not\s+supported\b/i,
  /\breasoning\s+continuation\s+is\s+not\s+compatible\b/i,
  // Model-specific context/token boundaries
  /\bcontext[_\s]length[_\s]exceeded\b/i,
  /\bmaximum\s+context\s+length\b/i,
  /\bprompt\s+is\s+too\s+long\b/i,
  /\bexceeds?\s+(?:the\s+)?model(?:'s)?\s+context\s+limit\b/i,
];

/** #5249 / #2101: model-scoped 400s must not stop the combo. */
export function isModelScoped400(errorText: string | null | undefined): boolean {
  const text = String(errorText || "");
  if (!text) return false;
  if (MODEL_ACCESS_DENIED_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return (
    /\bmodel\b[\s\S]{0,80}?\b(?:not\s+supported|unsupported|unknown|unavailable)\b/i.test(text) ||
    /\b(?:not\s+supported|unsupported|unknown)\b[\s\S]{0,80}?\bmodel\b/i.test(text) ||
    /\bunsupported_api_for_model\b/i.test(text) ||
    /\bdoes\s+not\s+support\s+(?:the\s+)?responses\s+api\b/i.test(text)
  );
}
