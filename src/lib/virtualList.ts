export interface VirtualWindow<T> {
  items: T[];
  startIndex: number;
  endIndex: number;
  offsetTop: number;
  totalHeight: number;
}

/** Calculate a fixed-row virtual window without rendering the entire collection. */
export function getVirtualWindow<T>(
  items: T[],
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 27,
  overscan = 8,
): VirtualWindow<T> {
  const safeRowHeight = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 27;
  const safeViewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : safeRowHeight;
  const safeScrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const safeOverscan = Number.isFinite(overscan) ? Math.max(0, Math.floor(overscan)) : 8;
  const visibleRows = Math.ceil(safeViewport / safeRowHeight);
  const startIndex = Math.min(items.length, Math.max(0, Math.floor(safeScrollTop / safeRowHeight) - safeOverscan));
  const endIndex = Math.min(items.length, startIndex + visibleRows + safeOverscan * 2);
  return {
    items: items.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    offsetTop: startIndex * safeRowHeight,
    totalHeight: items.length * safeRowHeight,
  };
}
