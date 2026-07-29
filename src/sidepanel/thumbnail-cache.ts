const THUMBNAIL_CACHE_NAME = 'maltlock-thumbnails-v1'
const CACHE_KEY_PREFIX = '/__maltlock_thumbnail_cache__/'
const MAX_CACHED_THUMBNAILS = 500
const SOURCE_URL_HEADER = 'x-maltlock-source-url'
const CACHED_AT_HEADER = 'x-maltlock-cached-at'

function isCacheStorageAvailable(): boolean {
  return typeof caches !== 'undefined'
}

function createCacheKey(itemId: string): string {
  return new URL(
    `${CACHE_KEY_PREFIX}${encodeURIComponent(itemId)}`,
    'https://maltlock.local',
  ).toString()
}

async function trimThumbnailCache(cache: Cache): Promise<void> {
  const keys = await cache.keys()
  if (keys.length <= MAX_CACHED_THUMBNAILS) return

  const entries = await Promise.all(
    keys.map(async (key) => {
      const response = await cache.match(key)
      const cachedAt = Number(response?.headers.get(CACHED_AT_HEADER) ?? 0)
      return { key, cachedAt }
    }),
  )
  const staleKeys = entries
    .sort((first, second) => first.cachedAt - second.cachedAt)
    .slice(0, entries.length - MAX_CACHED_THUMBNAILS)
    .map((entry) => entry.key)
  await Promise.all(staleKeys.map((key) => cache.delete(key)))
}

async function fetchThumbnail(url: string): Promise<Blob> {
  const response = await fetch(url, {
    cache: 'force-cache',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new Error(`Thumbnail request failed: ${response.status}`)

  const blob = await response.blob()
  if (blob.size === 0 || !blob.type.toLowerCase().startsWith('image/')) {
    throw new Error('Thumbnail response is not a valid image.')
  }
  return blob
}

export async function loadPersistentThumbnail(
  itemId: string,
  sourceUrl: string,
): Promise<Blob | undefined> {
  if (!isCacheStorageAvailable()) return undefined

  const cache = await caches.open(THUMBNAIL_CACHE_NAME)
  const cacheKey = createCacheKey(itemId)
  const cached = await cache.match(cacheKey)
  const cachedSourceUrl = cached?.headers.get(SOURCE_URL_HEADER)

  if (cached && cachedSourceUrl === sourceUrl) return cached.blob()

  try {
    const blob = await fetchThumbnail(sourceUrl)
    await cache.put(
      cacheKey,
      new Response(blob, {
        headers: {
          'content-type': blob.type,
          [SOURCE_URL_HEADER]: sourceUrl,
          [CACHED_AT_HEADER]: `${Date.now()}`,
        },
      }),
    )
    void trimThumbnailCache(cache).catch(() => undefined)
    return blob
  } catch {
    return cached?.blob()
  }
}

export async function removePersistentThumbnail(itemId: string): Promise<void> {
  if (!isCacheStorageAvailable()) return
  const cache = await caches.open(THUMBNAIL_CACHE_NAME)
  await cache.delete(createCacheKey(itemId))
}

export async function clearPersistentThumbnails(): Promise<void> {
  if (!isCacheStorageAvailable()) return
  await caches.delete(THUMBNAIL_CACHE_NAME)
}
