/**
 * Note types — match the Obsidian frontmatter that navetted writes to the
 * sync folder. The daemon is the source of truth for file format; these
 * mirror the shape so consumers can render previews without re-parsing YAML.
 */

export type IdeaStatus = "seedling" | "developing" | "mature";

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
