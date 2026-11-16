export type ExtensionManifestReview = {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  publisher: string;
  license: string;
  description: string;
  capabilities: string[];
};

const REQUIRED_TEXT_FIELDS = ["id", "name", "version", "publisher", "license", "description"] as const;
const ALLOWED_FIELDS = new Set<string>(["manifestVersion", ...REQUIRED_TEXT_FIELDS, "capabilities"]);
const MAX_FIELD_LENGTH = 500;
const MAX_CAPABILITIES = 32;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

export function validateExtensionManifest(value: unknown): ExtensionManifestReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest must be a JSON object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Manifest must be a plain JSON object.");
  }

  const record = value as Record<string, unknown>;
  if (record.manifestVersion !== 1) {
    throw new Error("Unsupported or missing manifestVersion; this host supports version 1.");
  }
  for (const field of Object.keys(record)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new Error("Unknown manifest field: " + field);
    }
  }
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field) ||
        typeof record[field] !== "string" || !(record[field] as string).trim()) {
      throw new Error("Missing required text field: " + field);
    }
    const normalized = (record[field] as string).trim();
    if (new TextEncoder().encode(normalized).length > MAX_FIELD_LENGTH) {
      throw new Error("Field exceeds the 500-character limit: " + field);
    }
    if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
      throw new Error("Field contains unsupported control characters: " + field);
    }
  }

  const id = (record.id as string).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(id)) {
    throw new Error("Extension id must be 2–80 characters using letters, numbers, dot, underscore, or hyphen.");
  }
  const version = (record.version as string).trim();
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error("Extension version must follow semantic versioning (MAJOR.MINOR.PATCH).");
  }

  const rawCapabilities = record.capabilities === undefined ? [] : record.capabilities;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length > MAX_CAPABILITIES ||
      rawCapabilities.some(item => typeof item !== "string" || !item ||
        item.length > 100 || !CAPABILITY_PATTERN.test(item))) {
    throw new Error("Capabilities must be at most 32 valid lowercase capability identifiers.");
  }
  const capabilities = rawCapabilities as string[];
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Manifest contains duplicate capability identifiers.");
  }

  return {
    manifestVersion: 1,
    id,
    name: (record.name as string).trim(),
    version,
    publisher: (record.publisher as string).trim(),
    license: (record.license as string).trim(),
    description: (record.description as string).trim(),
    capabilities,
  };
}
