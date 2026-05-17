/**
 * Note types shared between mobile and desktop.
 */

export type IdeaStatus = "seedling" | "developing" | "mature";

export type CaptureStatus = "ok" | "error";

/**
 * Preview response shape used by CaptureScreen to hold the OmniRoute result
 * before the user confirms saving.
 */
export interface CaptureResponse {
  type: "capture_response";
  request_id: string;
  status: CaptureStatus;
  filepath?: string;
  preview_markdown?: string;
  error?: string;
}

export interface IdeaNote {
  created: string;
  status: IdeaStatus;
  tags: string[];
  source?: string;
}

export interface JournalEntry {
  date: string;
  transcript: string;
  people: string[];
  ideas: string[];
  tags: string[];
}

export interface PersonNote {
  name: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  linkedin: string;
  met: string;
  where: string;
  tags: string[];
}
