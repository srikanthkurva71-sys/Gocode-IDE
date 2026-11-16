export type OpenVsxExtension = {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  publisher: string;
  description: string;
  downloadCount: number;
  averageRating: number | null;
  reviewCount: number;
  license: string;
  categories: string[];
  url: string;
};

const REGISTRY_ORIGIN = "https://open-vsx.org";
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 20;

const MAX_RESPONSE_BYTES = 1024 * 1024;

export async function readBoundedOpenVsxJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error("Open VSX response exceeds the 1 MiB size limit.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Open VSX returned an empty response body.");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Open VSX response exceeds the 1 MiB size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Open VSX returned invalid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function safeRating(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 5
    ? value
    : null;
}

function safeCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12)
    .map(item => boundedText(item, 50))
    .filter(Boolean);
}

/** Parse only bounded, display-safe fields from the public Open VSX search response. */
export function parseOpenVsxSearchResponse(value: unknown): OpenVsxExtension[] {
  if (!isRecord(value) || !Array.isArray(value.extensions)) {
    throw new Error("Open VSX returned an unexpected search response.");
  }

  const results: OpenVsxExtension[] = [];
  for (const item of value.extensions.slice(0, MAX_RESULTS)) {
    if (!isRecord(item)) continue;
    const namespace = boundedText(item.namespace, 128);
    const name = boundedText(item.name, 128);
    const version = boundedText(item.version, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(namespace) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !version) {
      continue;
    }

    const publishedBy = isRecord(item.publishedBy) ? item.publishedBy : {};
    const license = boundedText(item.license, 100);
    results.push({
      namespace,
      name,
      version,
      displayName: boundedText(item.displayName, 160),
      publisher: boundedText(publishedBy.login, 128),
      description: boundedText(item.description, 1200),
      downloadCount: boundedCount(item.downloadCount),
      averageRating: safeRating(item.averageRating),
      reviewCount: boundedCount(item.reviewCount),
      license,
      categories: safeCategories(item.categories),
      url: `${REGISTRY_ORIGIN}/extension/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    });
  }
  return results;
}

/** Search Open VSX anonymously; this function never downloads or installs a package. */
export async function searchOpenVsxExtensions(
  query: string,
  signal?: AbortSignal,
): Promise<OpenVsxExtension[]> {
  const normalized = query.trim();
  if (!normalized) throw new Error("Enter an extension search term.");
  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new Error("Extension search is limited to 100 characters.");
  }

  const params = new URLSearchParams({
    query: normalized,
    size: String(MAX_RESULTS),
    sortBy: "downloadCount",
    sortOrder: "desc",
  });
  let response: Response;
  try {
    response = await fetch(`${REGISTRY_ORIGIN}/api/-/search?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("Could not reach Open VSX. Check your internet connection and try again.");
  }

  if (!response.ok) {
    if (response.status === 429) throw new Error("Open VSX rate limit reached. Wait a little before searching again.");
    throw new Error(`Open VSX search failed (HTTP ${response.status}).`);
  }

  const payload = await readBoundedOpenVsxJson(response);
  return parseOpenVsxSearchResponse(payload);
}
