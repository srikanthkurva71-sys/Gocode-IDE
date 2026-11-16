export type LspLaunchProfile = {
  name: string;
  executable: string;
  args: string[];
};

const MAX_PROFILES = 20;
const MAX_ARGUMENTS = 64;
const MAX_PROFILE_BYTES = 32 * 1024;
const SECRET_ARGUMENT_PATTERN = /(?:token|password|passwd|secret|api[-_]?key|client[-_]?secret|credential|authorization|auth[-_]?token)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteExecutablePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value);
}

export function containsSecretLikeLspArgument(args: string[]): boolean {
  return args.some(argument => SECRET_ARGUMENT_PATTERN.test(argument));
}

export function validateLspLaunchProfile(value: unknown): LspLaunchProfile {
  if (!isRecord(value)) throw new Error("Language-server profile must be an object.");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const executable = typeof value.executable === "string" ? value.executable.trim() : "";
  const args = value.args;

  if (!name || name.length > 60) throw new Error("Profile name must contain 1–60 characters.");
  if (!executable || executable.length > 4096 || !isAbsoluteExecutablePath(executable)) {
    throw new Error("Language-server executable must be an absolute path.");
  }
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS ||
      args.some(argument => typeof argument !== "string" || argument.length > 4096 || argument.includes("\0"))) {
    throw new Error("Language-server arguments must be at most 64 strings of 4096 characters each.");
  }
  if (containsSecretLikeLspArgument(args as string[])) {
    throw new Error("Profile arguments appear to contain credentials. Secret-like arguments cannot be saved; use a session-only launch instead.");
  }

  const profile = { name, executable, args: [...args] as string[] };
  if (new TextEncoder().encode(JSON.stringify(profile)).length > MAX_PROFILE_BYTES) {
    throw new Error("Language-server profile exceeds the 32 KiB size limit.");
  }
  return profile;
}

export function loadLspLaunchProfiles(raw: string | null): LspLaunchProfile[] {
  if (!raw || raw.length > MAX_PROFILE_BYTES * MAX_PROFILES) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const profiles: LspLaunchProfile[] = [];
    const seen = new Set<string>();
    for (const item of parsed.slice(0, MAX_PROFILES)) {
      try {
        const profile = validateLspLaunchProfile(item);
        const key = profile.name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        profiles.push(profile);
      } catch {
        // Ignore invalid or old entries without making the whole settings store unusable.
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

export function upsertLspLaunchProfile(
  profiles: LspLaunchProfile[],
  candidate: unknown,
): LspLaunchProfile[] {
  const profile = validateLspLaunchProfile(candidate);
  const key = profile.name.toLocaleLowerCase();
  const existing = profiles.filter(item => item.name.toLocaleLowerCase() !== key);
  if (existing.length >= MAX_PROFILES) throw new Error("A maximum of 20 language-server profiles is supported.");
  return [...existing, profile];
}
