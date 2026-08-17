export type RaindropResource = "collection" | "bookmark" | "highlight"

function namespacedKey(
  accountId: number,
  resource: RaindropResource,
  providerId: number | string
): string {
  return `raindrop:${accountId}:${resource}:${providerId}`
}

export function collectionKey(accountId: number, collectionId: number): string {
  return namespacedKey(accountId, "collection", collectionId)
}

export function bookmarkKey(accountId: number, bookmarkId: number): string {
  return namespacedKey(accountId, "bookmark", bookmarkId)
}

export function highlightKey(accountId: number, highlightId: string): string {
  return namespacedKey(accountId, "highlight", highlightId)
}
