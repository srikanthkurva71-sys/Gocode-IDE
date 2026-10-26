export type ExtensionManifestReview = {
  id: string;
  name: string;
  version: string;
  publisher: string;
  license: string;
  description: string;
  capabilities: string[];
};

const REQUIRED_TEXT_FIELDS = ["id", "name", "version", "publisher", "license", "description"] as const;
const MAX_FIELD_LENGTH = 500;
const MAX_CAPABILITIES = 32;

export function validateExtensionManifest(value: unknown): ExtensionManifestReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Manifest must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof record[field] !== "string" || !(record[field] as string).trim()) {
      throw new Error("Missing required text field: " + field);
    }
    if ((record[field] as string).length > MAX_FIELD_LENGTH) {
      throw new Error("Field exceeds the 500-character limit: " + field);
    }
  }
  const id = (record.id as string).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,79}$/.test(id)) {
    throw new Error("Extension id must be 2–80 characters using letters, numbers, dot, underscore, or hyphen.");
  }
  const rawCapabilities = record.capabilities === undefined ? [] : record.capabilities;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length > MAX_CAPABILITIES ||
      rawCapabilities.some(item => typeof item !== "string" || !item.trim() || item.length > 100)) {
    throw new Error("Capabilities must be a list of at most 32 short text labels.");
  }
  return {
    id,
    name: (record.name as string).trim(),
    version: (record.version as string).trim(),
    publisher: (record.publisher as string).trim(),
    license: (record.license as string).trim(),
    description: (record.description as string).trim(),
    capabilities: [...new Set((rawCapabilities as string[]).map(item => item.trim()))],
  };
}
