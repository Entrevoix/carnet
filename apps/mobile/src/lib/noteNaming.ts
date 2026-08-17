/**
 * Note naming: markdown title/name extraction and the filename-stem derivation
 * the vault writers build on (PURE — no filesystem access).
 *
 * `slugify` produces the ASCII stem for an idea file; `personFilename` the
 * "Firstname-Lastname" stem for a contact note. Both are deliberately strict
 * about what survives into an on-disk name — see each doc comment for why the
 * conservative behavior is a vault decision, not a gap. Collision bumping
 * (`{stem}-2.md`) needs to list a directory, so it stays in writer.ts.
 */

// Pure frontmatter helper; frontmatter.ts is native-free so this cannot form a
// cycle back into writer.ts.
import { extractFrontmatterField } from "./frontmatter";

/**
 * Letters that Unicode decomposition alone won't fold. NFD splits a
 * precomposed letter into base + combining mark, but ligatures (ß, æ, œ) and
 * stroke/bar letters (ø, ł, đ) are atomic — they have no combining form, so
 * stripping marks leaves them intact and the ASCII filter then drops them.
 * Everything decomposition *does* handle is deliberately absent here.
 */
const SPECIAL_FOLDS: Record<string, string> = {
  ß: "ss",
  æ: "ae", Æ: "ae", œ: "oe", Œ: "oe",
  ø: "o", Ø: "o",
  ł: "l", Ł: "l",
  đ: "d", Đ: "d", ð: "d", Ð: "d",
  þ: "th", Þ: "th",
  ħ: "h", Ħ: "h",
  ı: "i",
};

/**
 * Lowercase ASCII slug with hyphens. Folds Latin-script diacritics via NFD
 * decomposition, so "Mémoire" → "memoire" and "Dvořák" → "dvorak" — any
 * Latin diacritic, not a hand-listed set (this replaced a French-only accent
 * map, which silently dropped Polish/Czech/Vietnamese/Turkish letters).
 *
 * Non-Latin scripts (Cyrillic, CJK, Arabic…) still yield "" and callers fall
 * back to a generic stem ("idea"/"image"/"attachment"). That is deliberate,
 * not a gap: preserving those characters would change on-disk filename
 * encoding, which touches Syncthing's NFC/NFD normalization across platforms,
 * Obsidian link resolution, and exFAT-formatted cards. Revisit as a vault
 * decision, not a slug tweak.
 */
export function slugify(input: string): string {
  const folded = input
    // NFD splits "é" into "e" + U+0301; dropping the combining-mark range then
    // leaves plain ASCII. Also normalizes the precomposed/decomposed forms
    // Syncthing and macOS can each deliver for the same filename.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split("")
    .map((c) => SPECIAL_FOLDS[c] ?? c)
    .join("");

  let out = "";
  let prevDash = true;
  for (const c of folded) {
    if (/[a-zA-Z0-9]/.test(c)) {
      out += c.toLowerCase();
      prevDash = false;
    } else if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

/**
 * Derive filename stem for a person note: "Firstname-Lastname" (preserving
 * case, hyphenating spaces, stripping special chars except hyphens/apostrophes).
 * Strict allowlist — defense in depth against an LLM-controlled name field
 * (which could in theory contain path separators if a prompt injection
 * survived the delimiter guard). Returns "" on bad input; callers fall back.
 */
export function personFilename(name: string): string {
  const cleaned = name
    .split("")
    .filter((c) => /[a-zA-Z0-9\s\-']/.test(c))
    .join("");
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const stem = parts.join("-");
  // Allowlist assert: only letters / digits / hyphens / apostrophes survive.
  // ".." or "/" can't appear, but the regex makes the invariant explicit.
  if (!/^[A-Za-z0-9'\-]+$/.test(stem)) return "";
  return stem;
}

/**
 * Extract first/last name from a person markdown note. Tries `name:`
 * frontmatter first, then the H1. Used by CaptureScreen to derive a
 * filename stem before calling writePerson.
 */
export function extractNameFromMarkdown(
  markdown: string,
): { firstName: string; lastName: string } {
  const fromField = extractFrontmatterField(markdown, "name");
  const fromH1 = extractH1(markdown);
  const raw = fromField ?? fromH1;
  if (!raw) return { firstName: "", lastName: "" };
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Extract the first H1 title from markdown. */
export function extractH1(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).trim();
      if (title) return title;
    }
  }
  return null;
}
