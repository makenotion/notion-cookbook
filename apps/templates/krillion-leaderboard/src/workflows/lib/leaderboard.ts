export const PLACES = 3

export type Post = {
  userId: string
  message: string
  timestamp: string
}

// A result looks like "Krillion #106 🦐\n295\n\n🐟🐟🦑🐟🐟🐟🏮". People sometimes
// add words before it, after the header, or after the emoji row.
const RESULT = /Krillion #(\d+)[^\n]*\n\s*(\d+)\s*\n\s*(\S+)/

/**
 * Builds the leaderboard message from top-level channel posts, or returns null
 * when nobody posted a result. Ties go to whoever posted first.
 */
export function buildLeaderboard(posts: Post[]): string | null {
  const scores = []
  const oldestFirst = [...posts].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  )
  for (const post of oldestFirst) {
    const match = post.message.match(RESULT)
    if (match) {
      scores.push({
        userId: post.userId,
        puzzle: Number(match[1]),
        score: Number(match[2]),
        emojis: match[3],
      })
    }
  }

  // The last day can include a few late posts for the previous puzzle, so use
  // the puzzle most people played.
  const counts = new Map<number, number>()
  for (const { puzzle } of scores) {
    counts.set(puzzle, (counts.get(puzzle) ?? 0) + 1)
  }
  let puzzle = 0
  let most = 0
  for (const [candidate, count] of counts) {
    if (count > most || (count === most && candidate > puzzle)) {
      puzzle = candidate
      most = count
    }
  }

  // Keep each player's best score. The map keeps first-post order for ties.
  const best = new Map<string, (typeof scores)[number]>()
  for (const score of scores) {
    const current = best.get(score.userId)
    if (score.puzzle === puzzle && (!current || score.score > current.score)) {
      best.set(score.userId, score)
    }
  }

  const top = [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, PLACES)
  if (top.length === 0) {
    return null
  }
  return [
    `Krillion #${puzzle} 🦐 KRILLION LEADERBOARD`,
    ...top.map(
      ({ userId, score, emojis }) => `<@${userId}> - ${score} ${emojis}`
    ),
  ].join("\n")
}
