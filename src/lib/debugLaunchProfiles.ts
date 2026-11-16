export type DebugLaunchProfile = {
  name: string;
  executable: string;
  adapterArgs: string[];
  request: "launch" | "attach";
  configuration: Record<string, unknown>;
};

const MAX_PROFILES = 20;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_STORED_PROFILES_BYTES = MAX_CONFIG_BYTES * MAX_PROFILES;
const SECRET_FIELD_PATTERN = /(?:token|password|passwd|secret|api[-_]?key|client[-_]?secret|credential|authorization|auth[-_]?token|private[-_]?key|certificate)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error("Launch configuration is nested too deeply.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 8192) throw new Error("Launch configuration string exceeds 8192 characters.");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Launch configuration numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 200) throw new Error("Launch configuration array exceeds 200 entries.");
    return value.map(item => sanitizeJsonValue(item, depth + 1));
  }
  if (!isRecord(value)) throw new Error("Launch configuration must contain only JSON values.");
  const entries = Object.entries(value);
  if (entries.length > 100) throw new Error("Launch configuration object exceeds 100 properties.");
  const output: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 128 || key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Launch configuration contains an unsafe property name.");
    }
    output[key] = sanitizeJsonValue(item, depth + 1);
  }
  return output;
}

export function validateDebugLaunchProfile(value: unknown): DebugLaunchProfile {
  if (!isRecord(value)) throw new Error("Debug launch profile must be an object.");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const executable = typeof value.executable === "string" ? value.executable.trim() : "";
  const adapterArgs = value.adapterArgs;
  const request = value.request;
  const configuration = value.configuration;

  if (!name || name.length > 60) throw new Error("Profile name must contain 1–60 characters.");
  if (!executable || executable.length > 4096) throw new Error("Choose a valid adapter executable path.");
  if (!Array.isArray(adapterArgs) || adapterArgs.length > 64 ||
      adapterArgs.some(arg => typeof arg !== "string" || arg.length > 4096)) {
    throw new Error("Adapter arguments must be at most 64 strings of 4096 characters each.");
  }
  if (request !== "launch" && request !== "attach") throw new Error("Debug request must be launch or attach.");
  if (!isRecord(configuration)) throw new Error("Adapter configuration must be a JSON object.");

  const safeConfiguration = sanitizeJsonValue(configuration) as Record<string, unknown>;
  if (new TextEncoder().encode(JSON.stringify(safeConfiguration)).length > MAX_CONFIG_BYTES) {
    throw new Error("Launch configuration exceeds the 64 KiB size limit.");
  }

  return { name, executable, adapterArgs: [...adapterArgs], request, configuration: safeConfiguration };
}

function hasSecretLikeConfigurationField(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(item => hasSecretLikeConfigurationField(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    SECRET_FIELD_PATTERN.test(key) || hasSecretLikeConfigurationField(item, depth + 1)
  );
}

export function validatePersistableDebugLaunchProfile(value: unknown): DebugLaunchProfile {
  const profile = validateDebugLaunchProfile(value);
  if (profile.adapterArgs.some(argument => SECRET_FIELD_PATTERN.test(argument))) {
    throw new Error("Adapter arguments appear to contain credentials. This profile can be used for this session but cannot be saved.");
  }
  if (hasSecretLikeConfigurationField(profile.configuration)) {
    throw new Error("Adapter configuration contains a credential-like field. This profile can be used for this session but cannot be saved.");
  }
  return profile;
}

export function loadDebugLaunchProfiles(raw: string | null): DebugLaunchProfile[] {
  if (!raw || raw.length > MAX_STORED_PROFILES_BYTES) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const profiles: DebugLaunchProfile[] = [];
    const seen = new Set<string>();
    for (const item of parsed.slice(0, MAX_PROFILES)) {
      try {
        const profile = validatePersistableDebugLaunchProfile(item);
        const key = profile.name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        profiles.push(profile);
      } catch {
        // Ignore invalid legacy entries without making the settings store unusable.
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

export function upsertDebugLaunchProfile(
  profiles: DebugLaunchProfile[],
  candidate: unknown,
): DebugLaunchProfile[] {
  const profile = validatePersistableDebugLaunchProfile(candidate);
  const key = profile.name.toLocaleLowerCase();
  const existing = profiles.filter(item => item.name.toLocaleLowerCase() !== key);
  if (existing.length >= MAX_PROFILES) throw new Error("A maximum of 20 launch profiles is supported.");
  return [...existing, profile];
}
