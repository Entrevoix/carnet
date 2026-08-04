export function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
}

export function normalizeEmail(value: string): string {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return "";
  return normalized;
}

/**
 * Normalize a phone when it already has `+`, or when a country calling code is
 * explicitly supplied. Ambiguous national numbers remain unnormalized.
 */
export function normalizePhone(value: string, countryCallingCode?: string): string {
  const trimmed = normalizeWhitespace(value);
  const extensionStripped = trimmed.replace(/(?:ext\.?|x)\s*\d+$/i, "");
  const digits = extensionStripped.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  if (trimmed.startsWith("00") && digits.length >= 9 && digits.length <= 17) return `+${digits.slice(2)}`;
  if (countryCallingCode) {
    const code = countryCallingCode.replace(/\D/g, "");
    const national = digits.replace(/^0+/, "");
    const combined = `${code}${national}`;
    if (combined.length >= 7 && combined.length <= 15) return `+${combined}`;
  }
  return "";
}

export function normalizeName(value: string): string {
  return comparisonText(value);
}

export function normalizeOrganization(value: string): string {
  const words = comparisonText(value).split(" ");
  const suffixes = new Set(["inc", "incorporated", "ltd", "limited", "llc", "plc", "corp", "corporation"]);
  while (words.length > 1 && suffixes.has(words.at(-1) ?? "")) words.pop();
  return words.join(" ");
}

export function normalizeUrl(value: string): string {
  const input = normalizeWhitespace(value);
  if (!input) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname === "/") url.pathname = "";
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

export function normalizeIsoDate(value: string): string {
  const input = normalizeWhitespace(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input) && !Number.isNaN(Date.parse(`${input}T00:00:00Z`))) return input;
  return "";
}

function comparisonText(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
