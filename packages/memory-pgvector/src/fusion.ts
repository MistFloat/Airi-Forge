/**
 * Reciprocal Rank Fusion over independently ranked result lists.
 *
 * Vector cosine similarity and full-text `ts_rank` live on different scales, so
 * a candidate's raw scores cannot be merged directly. RRF uses only the position
 * of an item inside each list, giving every list an equal vote. It is the
 * standard fix for heterogeneous rankings (Cormack, Clarke & Büttcher,
 * "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning
 * Methods", SIGIR 2009).
 */

/** Standard RRF smoothing constant: score = Σ 1 / (k + rank). */
export const RRF_K = 60

/**
 * Fuses several ranked result lists into one score per item id.
 *
 * For every list an id appears in, its 1-based `rank` contributes `1 / (k + rank)`.
 * Items present in more lists, or higher inside them, score higher. The result is
 * only meaningful for ordering; it carries no per-list score semantics.
 *
 * @param rankedLists - One ordered list per ranking source, best first (index 0
 *   is rank 1). Lists are expected to be duplicate-free, which per-term SQL
 *   `LIMIT` queries already guarantee.
 * @param k - Smoothing constant; larger values shrink the bonus for rank 1.
 * @returns Map of id -> summed `Σ 1 / (k + rank)` score; ids absent from every
 *   list are omitted.
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyArray<string>>,
  k: number = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of rankedLists) {
    for (const [index, id] of list.entries()) {
      const rank = index + 1
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank))
    }
  }
  return scores
}
