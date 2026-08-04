import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface MdcrmConfig {
  knowledgeBasePath: string;
  processing: {
    autoCreateContactOnExactEmail: boolean;
    autoMergeContacts: boolean;
    createInteractions: boolean;
    createFollowUpSuggestions: boolean;
  };
  matching: {
    automaticMatchThreshold: number;
    reviewThreshold: number;
  };
  llm: {
    enabled: boolean;
    provider: string;
    model: string;
    allowExternalApi: boolean;
    includeImages: boolean;
  };
  indexing: { fullText: boolean; embeddings: boolean };
  sync: { adapter: "filesystem" };
  leaseSeconds: number;
}

export const DEFAULT_CONFIG: MdcrmConfig = {
  knowledgeBasePath: resolve("knowledge-base"),
  processing: {
    autoCreateContactOnExactEmail: true,
    autoMergeContacts: false,
    createInteractions: true,
    createFollowUpSuggestions: true,
  },
  matching: { automaticMatchThreshold: 100, reviewThreshold: 70 },
  llm: { enabled: false, provider: "local", model: "", allowExternalApi: false, includeImages: false },
  indexing: { fullText: true, embeddings: false },
  sync: { adapter: "filesystem" },
  leaseSeconds: 300,
};

export async function loadConfig(path?: string, environment = process.env): Promise<MdcrmConfig> {
  let file: Record<string, unknown> = {};
  if (path) {
    const parsed: unknown = parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error(`${path}: configuration must be a YAML mapping`);
    file = parsed;
  }
  const config = mergeConfig(DEFAULT_CONFIG, file);
  if (environment.MDCRM_KNOWLEDGE_BASE_PATH) {
    config.knowledgeBasePath = resolve(environment.MDCRM_KNOWLEDGE_BASE_PATH);
  } else {
    config.knowledgeBasePath = resolve(config.knowledgeBasePath);
  }
  if (environment.MDCRM_LLM_ENABLED) config.llm.enabled = parseBoolean(environment.MDCRM_LLM_ENABLED);
  if (environment.MDCRM_ALLOW_EXTERNAL_API) config.llm.allowExternalApi = parseBoolean(environment.MDCRM_ALLOW_EXTERNAL_API);
  validateConfig(config);
  return config;
}

function mergeConfig(defaults: MdcrmConfig, raw: Record<string, unknown>): MdcrmConfig {
  const processing = isRecord(raw.processing) ? raw.processing : {};
  const matching = isRecord(raw.matching) ? raw.matching : {};
  const llm = isRecord(raw.llm) ? raw.llm : {};
  const indexing = isRecord(raw.indexing) ? raw.indexing : {};
  const sync = isRecord(raw.sync) ? raw.sync : {};
  return {
    knowledgeBasePath: stringValue(raw.knowledge_base_path, defaults.knowledgeBasePath),
    processing: {
      autoCreateContactOnExactEmail: booleanValue(processing.auto_create_contact_on_exact_email, defaults.processing.autoCreateContactOnExactEmail),
      autoMergeContacts: booleanValue(processing.auto_merge_contacts, defaults.processing.autoMergeContacts),
      createInteractions: booleanValue(processing.create_interactions, defaults.processing.createInteractions),
      createFollowUpSuggestions: booleanValue(processing.create_follow_up_suggestions, defaults.processing.createFollowUpSuggestions),
    },
    matching: {
      automaticMatchThreshold: numberValue(matching.automatic_match_threshold, defaults.matching.automaticMatchThreshold),
      reviewThreshold: numberValue(matching.review_threshold, defaults.matching.reviewThreshold),
    },
    llm: {
      enabled: booleanValue(llm.enabled, defaults.llm.enabled), provider: stringValue(llm.provider, defaults.llm.provider),
      model: stringValue(llm.model, defaults.llm.model), allowExternalApi: booleanValue(llm.allow_external_api, defaults.llm.allowExternalApi),
      includeImages: booleanValue(llm.include_images, defaults.llm.includeImages),
    },
    indexing: {
      fullText: booleanValue(indexing.full_text, defaults.indexing.fullText),
      embeddings: booleanValue(indexing.embeddings, defaults.indexing.embeddings),
    },
    sync: { adapter: stringValue(sync.adapter, defaults.sync.adapter) as "filesystem" },
    leaseSeconds: numberValue(raw.lease_seconds, defaults.leaseSeconds),
  };
}

function validateConfig(config: MdcrmConfig): void {
  if (config.sync.adapter !== "filesystem") throw new Error(`Unsupported sync adapter: ${config.sync.adapter}`);
  if (config.matching.reviewThreshold < 0 || config.matching.automaticMatchThreshold < config.matching.reviewThreshold) {
    throw new Error("Matching thresholds must satisfy 0 <= review <= automatic");
  }
  if (config.llm.enabled && config.llm.provider !== "local" && !config.llm.allowExternalApi) {
    throw new Error("External LLM provider requires llm.allow_external_api: true");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function booleanValue(value: unknown, fallback: boolean): boolean { return typeof value === "boolean" ? value : fallback; }
function numberValue(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function parseBoolean(value: string): boolean { if (value === "1" || value === "true") return true; if (value === "0" || value === "false") return false; throw new Error(`Invalid boolean environment value: ${value}`); }
