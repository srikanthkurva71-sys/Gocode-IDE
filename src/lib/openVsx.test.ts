import { describe, expect, it } from "vitest";
import { parseOpenVsxSearchResponse } from "./openVsx";

describe("parseOpenVsxSearchResponse", () => {
  it("maps registry metadata into bounded display fields", () => {
    const results = parseOpenVsxSearchResponse({
      extensions: [{
        namespace: "publisher",
        name: "python-tools",
        version: "1.2.3",
        displayName: "Python Tools",
        publishedBy: { login: "publisher" },
        description: "Python support",
        downloadCount: 1250,
        averageRating: 4.5,
        reviewCount: 10,
        license: "MIT",
        categories: ["Programming Languages", "Formatters"],
      }],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      namespace: "publisher",
      name: "python-tools",
      displayName: "Python Tools",
      publisher: "publisher",
      downloadCount: 1250,
      averageRating: 4.5,
      reviewCount: 10,
      license: "MIT",
      categories: ["Programming Languages", "Formatters"],
      url: "https://open-vsx.org/extension/publisher/python-tools",
    });
  });

  it("skips entries with unsafe namespace or extension identifiers", () => {
    const results = parseOpenVsxSearchResponse({
      extensions: [
        { namespace: "../attacker", name: "bad", version: "1.0.0" },
        { namespace: "publisher", name: "safe", version: "1.0.0" },
      ],
    });
    expect(results.map(item => item.name)).toEqual(["safe"]);
  });

  it("caps result count and display metadata", () => {
    const results = parseOpenVsxSearchResponse({
      extensions: Array.from({ length: 30 }, (_, index) => ({
        namespace: "publisher",
        name: `extension-${index}`,
        version: "1.0.0",
        description: "x".repeat(2000),
        downloadCount: -10,
        averageRating: 99,
        categories: Array.from({ length: 20 }, () => "category"),
      })),
    });
    expect(results).toHaveLength(20);
    expect(results[0].description).toHaveLength(1200);
    expect(results[0].downloadCount).toBe(0);
    expect(results[0].averageRating).toBeNull();
    expect(results[0].categories).toHaveLength(12);
  });

  it("rejects an unexpected response envelope", () => {
    expect(() => parseOpenVsxSearchResponse({ results: [] })).toThrow(/unexpected search response/);
  });
});
