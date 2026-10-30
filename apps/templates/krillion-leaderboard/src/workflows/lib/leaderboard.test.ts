import assert from "node:assert/strict"
import { test } from "node:test"

import { buildLeaderboard, type Post } from "./leaderboard.ts"

function post(userId: string, message: string, timestamp: string): Post {
  return { userId, message, timestamp: `2026-10-29T${timestamp}:00.000Z` }
}

test("buildLeaderboard posts the top scores for the day's puzzle", () => {
  const posts = [
    post("U1", "Krillion #106 🦐\n295\n\n🐟🐟🦑🐟🐟🐟🏮", "23:39"),
    post("U2", "Krillion #106 🦐\n495\n\n🏮🏮🦑🦑🏮🦑🦑", "23:27"),
    post("U3", "Krillion #106 🦐\n260\n:bubbles:🦑:bubbles:🐟🐟🦑🦑", "20:47"),
    post("U4", "Krillion #106 🦐\n465\n\n🦑🏮🦑🏮🦑🏮🐟", "19:34"),
    post("U5", "Krillion #105 🦐\n545\n\n🦑🏮🏮🦑🏮🏮🏮", "03:08"),
    post("U6", "nice one", "19:00"),
  ]

  assert.equal(
    buildLeaderboard(posts),
    [
      "Krillion #106 🦐 KRILLION LEADERBOARD",
      "<@U2> - 495 🏮🏮🦑🦑🏮🦑🦑",
      "<@U4> - 465 🦑🏮🦑🏮🦑🏮🐟",
      "<@U1> - 295 🐟🐟🦑🐟🐟🐟🏮",
    ].join("\n")
  )
})

test("buildLeaderboard ignores extra words around a result", () => {
  const posts = [
    post(
      "U1",
      "i'm new here\n\nKrillion #106 🦐 finally broke 200\n200\n\n🦑⬛🐟 so close",
      "12:00"
    ),
  ]

  assert.equal(
    buildLeaderboard(posts),
    "Krillion #106 🦐 KRILLION LEADERBOARD\n<@U1> - 200 🦑⬛🐟"
  )
})

test("buildLeaderboard keeps each player's best score and breaks ties by first post", () => {
  const posts = [
    post("U1", "Krillion #106 🦐\n300\n\n🐟", "15:00"),
    post("U2", "Krillion #106 🦐\n400\n\n🦑", "14:00"),
    post("U1", "Krillion #106 🦐\n400\n\n🏮", "16:00"),
    post("U3", "Krillion #106 🦐\n400\n\n🦐", "13:00"),
  ]

  assert.equal(
    buildLeaderboard(posts),
    [
      "Krillion #106 🦐 KRILLION LEADERBOARD",
      "<@U3> - 400 🦐",
      "<@U2> - 400 🦑",
      "<@U1> - 400 🏮",
    ].join("\n")
  )
})

test("buildLeaderboard skips leaderboards and returns null without results", () => {
  const posts = [
    post(
      "U1",
      "Krillion #106 🦐 KRILLION LEADERBOARD\n<@U2> - 495 🦑",
      "18:00"
    ),
    post("U2", "Attached files:\nFile type: png", "17:00"),
  ]

  assert.equal(buildLeaderboard(posts), null)
})
