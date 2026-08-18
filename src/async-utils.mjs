/**
 * Run independent reads with a small concurrency cap while preserving input
 * order. This avoids turning a large workbook into a burst of API requests.
 */
export async function mapConcurrent(items, mapper, limit = 8) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
