/**
 * concurrencyLimit.js
 * -----------------------------------------------------------------------
 * Runs an array of async task-producing functions with a max number
 * in flight at once — needed when fetching OHLCV for potentially
 * hundreds of symbols (the scanner's "whole exchange" universe) without
 * hammering the exchange's rate limits.
 * -----------------------------------------------------------------------
 */

/**
 * @template T
 * @param {(() => Promise<T>)[]} tasks
 * @param {number} concurrency
 * @returns {Promise<(T|{ error: Error })[]>} results in the same order as
 *   `tasks`; failed tasks resolve to `{ error }` instead of rejecting the
 *   whole batch.
 */
async function runWithLimit(tasks, concurrency = 5) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = await tasks[i]();
      } catch (error) {
        results[i] = { error };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { runWithLimit };
