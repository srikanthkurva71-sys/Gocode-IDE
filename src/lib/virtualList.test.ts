import { describe, expect, it } from "vitest";
import { getVirtualWindow } from "./virtualList";

describe("fixed-row virtual list window", () => {
  const items = Array.from({ length: 1000 }, (_, index) => index);

  it("renders only the viewport plus overscan and reports spacer geometry", () => {
    const window = getVirtualWindow(items, 2700, 270);
    expect(window.startIndex).toBe(92);
    expect(window.items).toHaveLength(26);
    expect(window.items[0]).toBe(92);
    expect(window.offsetTop).toBe(2484);
    expect(window.totalHeight).toBe(27000);
  });

  it("clamps scrolling at the end of the collection", () => {
    const window = getVirtualWindow(items, 1_000_000, 270);
    expect(window.startIndex).toBe(1000);
    expect(window.items).toEqual([]);
    expect(window.offsetTop).toBe(window.totalHeight);
  });

  it("handles empty lists and invalid geometry safely", () => {
    expect(getVirtualWindow([], 0, 270).items).toEqual([]);
    const window = getVirtualWindow(items, Number.NaN, Number.NaN, 0, -2);
    expect(window.startIndex).toBe(0);
    expect(window.items.length).toBeGreaterThan(0);
    expect(window.totalHeight).toBe(27000);
  });
});
