/**
 * OmniRoute OCR client. The mobile app captures a business card image, posts
 * it to OmniRoute's `/v1/ocr` route, and gets back the extracted text.
 *
 * `/v1/ocr` is Mistral-OCR-API-compatible, NOT a bespoke `{image_b64}` shape:
 * the body is `{ model?, document: { image_url } }`, where `image_url` is a
 * data URI (or `document_url` for a remote URL). `model` defaults server-side
 * to `mistral-ocr-latest` when omitted, so it's left unset here rather than
 * guessing a chat/vision model name that wouldn't resolve against the OCR
 * provider registry. The server also requires the caller's own OmniRoute
 * Authorization Bearer token (checked before provider credentials) — every
 * other OmniRoute client call sends this; this one previously didn't.
 *
 * If the OmniRoute URL is empty in settings, callers should fall back to
 * sending a manual text payload (the prompt accepts free-text in `OCR_INPUT`).
 */

export interface OcrResult {
  text: string;
}

export async function ocrBusinessCard(
  omniRouteUrl: string,
  apiKey: string,
  base64Image: string,
  mimeType: string,
): Promise<OcrResult> {
  const trimmed = omniRouteUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OmniRoute URL not configured");
  }
  const response = await fetch(`${trimmed}/v1/ocr`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      document: { image_url: `data:${mimeType};base64,${base64Image}` },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `OmniRoute returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  // Mistral's actual OCR response shape is `{ pages: [{ markdown, ... }], ... }`,
  // not a flat `{ text }` — one page per document page (a business-card photo
  // is a single page). Join in page order so multi-page documents don't lose
  // content; a card scan will just have one element.
  const json = (await response.json()) as {
    pages?: Array<{ markdown?: string }>;
  };
  const text = (json.pages ?? [])
    .map((page) => page.markdown ?? "")
    .join("\n\n")
    .trim();
  if (!text) {
    throw new Error("OmniRoute response contained no OCR text");
  }
  return { text };
}
