import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 = require("ajv/dist/2020.js");
import type { ErrorObject, ValidateFunction } from "ajv";

import type { AnyRecord, RecordType } from "../models/records.js";

const RECORD_TYPES: RecordType[] = [
  "capture", "contact", "organization", "event", "interaction", "task",
  "review_item", "processing_job", "proposed_change",
];

export interface ValidationIssue {
  path: string;
  message: string;
}

export class RecordValidationError extends Error {
  constructor(readonly issues: ValidationIssue[], readonly sourcePath?: string) {
    super(`${sourcePath ? `${sourcePath}: ` : ""}${issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ")}`);
    this.name = "RecordValidationError";
  }
}

export class SchemaRegistry {
  private readonly validators = new Map<RecordType, ValidateFunction>();

  constructor(schemaDir = bundledSchemaDirectory()) {
    const ajv = new Ajv2020.default({ allErrors: true, strict: true });
    ajv.addFormat("date-time", { type: "string", validate: (value: string) => !Number.isNaN(Date.parse(value)) && /T/.test(value) });
    ajv.addFormat("date", { type: "string", validate: (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) });
    const common = readJson(`${schemaDir}/common.schema.json`);
    ajv.addSchema(common);
    for (const type of RECORD_TYPES) {
      const schema = readJson(`${schemaDir}/${type}.schema.json`);
      this.validators.set(type, ajv.compile(schema));
    }
  }

  validate(value: unknown, sourcePath?: string): AnyRecord {
    if (!isRecord(value) || typeof value.type !== "string" || !RECORD_TYPES.includes(value.type as RecordType)) {
      throw new RecordValidationError([{ path: "/type", message: "must be a supported record type" }], sourcePath);
    }
    const validate = this.validators.get(value.type as RecordType);
    if (!validate || !validate(value)) {
      throw new RecordValidationError(formatErrors(validate?.errors ?? []), sourcePath);
    }
    return value as unknown as AnyRecord;
  }
}

export function bundledSchemaDirectory(): string {
  const sourceCandidate = fileURLToPath(new URL("../../schemas", import.meta.url));
  const builtCandidate = fileURLToPath(new URL("../../../schemas", import.meta.url));
  try {
    readFileSync(`${sourceCandidate}/common.schema.json`);
    return sourceCandidate;
  } catch {
    return builtCandidate;
  }
}

function readJson(path: string): object {
  return JSON.parse(readFileSync(path, "utf8")) as object;
}

function formatErrors(errors: ErrorObject[]): ValidationIssue[] {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? error.keyword,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
