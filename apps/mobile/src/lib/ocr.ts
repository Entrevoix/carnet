/**
 * OmniRoute OCR client. The mobile app captures a business card image, posts
 * it to OmniRoute, and gets back the extracted text. That text is then sent
 * to navetted as the `ocr_result` field of `capture/person`.
 *
 * If the OmniRoute URL is empty in settings, callers should fall back to
 * sending a manual text payload (the prompt accepts free-text in `OCR_INPUT`).
 */

export interface OcrResult {
  text: string;
}

export async function ocrBusinessCard(
  omniRouteUrl: string,
  base64Image: string,
): Promise<OcrResult> {
  const trimmed = omniRouteUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("OmniRoute URL not configured");
  }
  const response = await fetch(`${trimmed}/ocr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_b64: base64Image }),
  });
  if (!response.ok) {
    throw new Error(
      `OmniRoute returned HTTP ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as { text?: string };
  if (typeof json.text !== "string") {
    throw new Error("OmniRoute response missing 'text' field");
  }
  return { text: json.text };
}
