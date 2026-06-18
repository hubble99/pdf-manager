export const parsePageRange = (input: string, total: number): Set<number> => {
  const result = new Set<number>();
  if (!input || !input.trim()) {
    // If empty, return all pages
    for (let i = 1; i <= total; i++) {
      result.add(i);
    }
    return result;
  }

  const parts = input.split(',').map((p) => p.trim());
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let i = Math.max(1, start); i <= Math.min(total, end); i++) {
          result.add(i);
        }
      }
    } else {
      const val = parseInt(part, 10);
      if (!isNaN(val) && val >= 1 && val <= total) {
        result.add(val);
      }
    }
  }
  return result;
};

export const isPageInRange = (page: number, input: string, total: number): boolean => {
  const parsed = parsePageRange(input, total);
  return parsed.has(page);
};
