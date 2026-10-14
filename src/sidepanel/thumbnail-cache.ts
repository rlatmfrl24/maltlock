const THUMBNAIL_CACHE_NAME = 'maltlock-thumbnails-v1'
const CACHE_KEY_PREFIX = '/__maltlock_thumbnail_cache__/'
const MAX_CACHED_THUMBNAILS = 500
const SOURCE_URL_HEADER = 'x-maltlock-source-url'
const CACHED_AT_HEADER = 'x-maltlock-cached-at'
const pendingWrites = new Map<string, Promise<void>>()

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

async function fetchThumbnail(url: string, signal?: AbortSignal): Promise<Blob> {
  const timeout = AbortSignal.timeout(10_000)
  const response = await fetch(url, {
    cache: 'force-cache',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
  signal?: AbortSignal,
): Promise<Blob | undefined> {
  const cache = isCacheStorageAvailable()
    ? await caches.open(THUMBNAIL_CACHE_NAME).catch(() => undefined)
    : undefined
  const cacheKey = createCacheKey(itemId)
  const cached = await cache?.match(cacheKey).catch(() => undefined)
  const cachedSourceUrl = cached?.headers.get(SOURCE_URL_HEADER)

  if (cached && cachedSourceUrl === sourceUrl) return cached.blob()

  try {
    const blob = await fetchThumbnail(sourceUrl, signal)
    signal?.throwIfAborted()
    if (cache) {
      // Display immediately; keep writes ordered so deletion can finish after them.
      const write = Promise.resolve(pendingWrites.get(itemId)).then(() => cache.put(
        cacheKey,
        new Response(blob, {
          headers: {
            'content-type': blob.type,
            [SOURCE_URL_HEADER]: sourceUrl,
            [CACHED_AT_HEADER]: `${Date.now()}`,
          },
        }),
      )).catch(() => undefined)
      pendingWrites.set(itemId, write)
      void write.then(() => {
        if (pendingWrites.get(itemId) === write) pendingWrites.delete(itemId)
        return trimThumbnailCache(cache)
      }).catch(() => undefined)
    }
    return blob
  } catch {
    return cached?.blob()
  }
}

export async function removePersistentThumbnail(itemId: string): Promise<void> {
  if (!isCacheStorageAvailable()) return
  await pendingWrites.get(itemId)
  const cache = await caches.open(THUMBNAIL_CACHE_NAME)
  await cache.delete(createCacheKey(itemId))
}
