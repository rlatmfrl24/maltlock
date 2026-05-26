import Dexie from 'dexie'
import type {
  CrawledItem,
  CrawledItemLog,
  CrawlRun,
  ParsedItem,
} from '../types/contracts'
import { hashString } from '../utils/hash'
import { db } from './schema'

const MAX_SNIPPET_LENGTH = 280
const TWIMG_MEDIA_ID_REGEX =
  /\/(?:amplify_video|ext_tw_video|amplify_video_thumb|ext_tw_video_thumb)\/(\d+)(?:\/|$)/i
const TWEET_STATUS_ID_REGEX = /\/status\/(\d+)/i
const DEDUPE_MEDIA_ID_REGEX = /(?:^|:)(?:video-id|preview-id):([^:\s]+)$/i
const DEDUPE_TWEET_STATUS_ID_REGEX = /(?:^|:)tweet-status:(\d+)$/i
const DEDUPE_PATH_REGEX = /(?:^|:)path:(\/.*)$/i
const DEDUPE_VIDEO_PREVIEW_KEY_REGEX = /^(.+:)(video-id|preview-id):([^:\s]+)$/i

interface NormalizedCrawledItem {
  item: CrawledItem
  equivalentItemIds: string[]
  stableFingerprints: string[]
}

function normalizeUrl(input: string): string {
  try {
    return new URL(input).toString()
  } catch {
    return input.trim()
  }
}

function normalizePreviewImageUrl(input: string | undefined): string | undefined {
  if (!input) {
    return undefined
  }

  const trimmed = input.trim()

  if (!trimmed || trimmed.startsWith('data:')) {
    return undefined
  }

  return normalizeUrl(trimmed)
}

function clipSnippet(input: string | undefined): string | undefined {
  if (!input) {
    return undefined
  }

  const normalized = input.trim()

  if (!normalized) {
    return undefined
  }

  if (normalized.length <= MAX_SNIPPET_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, MAX_SNIPPET_LENGTH - 3)}...`
}

function normalizeUrlPath(input: string): string | undefined {
  try {
    const parsed = new URL(input)
    const path = parsed.pathname.trim().toLowerCase()
    return path && path !== '/' ? path : undefined
  } catch {
    return undefined
  }
}

function addFingerprint(fingerprints: Set<string>, value: string | undefined): void {
  const normalized = value?.trim().toLowerCase()

  if (normalized) {
    fingerprints.add(normalized)
  }
}

function dedupeByItemId(items: NormalizedCrawledItem[]): NormalizedCrawledItem[] {
  const deduped = new Map<string, NormalizedCrawledItem>()

  for (const item of items) {
    // Keep the latest value when the same id appears multiple times in one crawl batch.
    deduped.set(item.item.id, item)
  }

  return [...deduped.values()]
}

function addUrlFingerprints(
  fingerprints: Set<string>,
  input: string | undefined,
): void {
  if (!input) {
    return
  }

  const path = normalizeUrlPath(input)
  if (path) {
    addFingerprint(fingerprints, `url-path:${path}`)
  }

  const tweetStatusId = input.match(TWEET_STATUS_ID_REGEX)?.[1]
  if (tweetStatusId) {
    addFingerprint(fingerprints, `tweet-status:${tweetStatusId}`)
  }

  const mediaId = input.match(TWIMG_MEDIA_ID_REGEX)?.[1]
  if (mediaId) {
    addFingerprint(fingerprints, `media-id:${mediaId}`)
  }
}

function addDedupeKeyFingerprints(
  fingerprints: Set<string>,
  dedupeKey: string | undefined,
): void {
  const normalizedDedupeKey = normalizeDedupeKey(dedupeKey)
  if (!normalizedDedupeKey) {
    return
  }

  const path = normalizedDedupeKey.match(DEDUPE_PATH_REGEX)?.[1]
  if (path) {
    addFingerprint(fingerprints, `url-path:${path}`)
  }

  const mediaId = normalizedDedupeKey.match(DEDUPE_MEDIA_ID_REGEX)?.[1]
  if (mediaId) {
    addFingerprint(fingerprints, `media-id:${mediaId}`)
  }

  const tweetStatusId = normalizedDedupeKey.match(DEDUPE_TWEET_STATUS_ID_REGEX)?.[1]
  if (tweetStatusId) {
    addFingerprint(fingerprints, `tweet-status:${tweetStatusId}`)
  }
}

function createStableFingerprints(
  item: Pick<CrawledItem, 'url' | 'previewImageUrl' | 'summary'> & {
    dedupeKey?: string
  },
): string[] {
  const fingerprints = new Set<string>()

  addUrlFingerprints(fingerprints, item.url)
  addUrlFingerprints(fingerprints, item.previewImageUrl)
  addUrlFingerprints(fingerprints, item.summary)
  addDedupeKeyFingerprints(fingerprints, item.dedupeKey)

  return [...fingerprints]
}

async function listExistingItemsByStableFingerprint(
  siteId: string,
  items: NormalizedCrawledItem[],
): Promise<Map<string, CrawledItem>> {
  const targetFingerprints = new Set(
    items
      .flatMap((item) => item.stableFingerprints)
      .filter((fingerprint) => Boolean(fingerprint)),
  )

  if (targetFingerprints.size === 0) {
    return new Map()
  }

  const existingItems = await db.items.where('siteId').equals(siteId).toArray()
  const existingItemByFingerprint = new Map<string, CrawledItem>()

  for (const item of existingItems) {
    const stableFingerprints = createStableFingerprints(item)

    for (const stableFingerprint of stableFingerprints) {
      if (targetFingerprints.has(stableFingerprint)) {
        existingItemByFingerprint.set(stableFingerprint, item)
      }
    }
  }

  return existingItemByFingerprint
}

export interface UpsertCrawledItemsResult {
  items: CrawledItem[]
  insertedCount: number
  skippedCount: number
}

function normalizeDedupeKey(input: string | undefined): string | undefined {
  if (!input) {
    return undefined
  }

  const normalized = input.trim().toLowerCase()
  return normalized || undefined
}

export function createItemId(
  siteId: string,
  url: string,
  title: string,
  dedupeKey?: string,
): string {
  const normalizedDedupeKey = normalizeDedupeKey(dedupeKey)
  const normalized = normalizedDedupeKey
    ? `dedupe:${normalizedDedupeKey}`
    : `${normalizeUrl(url).toLowerCase()}|${title.trim().toLowerCase()}`
  return `${siteId}:${hashString(normalized)}`
}

function createItemLog(item: CrawledItem): CrawledItemLog {
  return {
    id: item.id,
    siteId: item.siteId,
    itemId: item.id,
    firstSeenAt: item.crawledAt,
    lastSeenAt: item.crawledAt,
    seenCount: 1,
  }
}

function getEquivalentDedupeKeys(
  _siteId: string,
  dedupeKey: string | undefined,
): string[] {
  const normalizedDedupeKey = normalizeDedupeKey(dedupeKey)
  if (!normalizedDedupeKey) {
    return []
  }

  const videoPreviewMatch = normalizedDedupeKey.match(DEDUPE_VIDEO_PREVIEW_KEY_REGEX)
  if (videoPreviewMatch) {
    const prefix = videoPreviewMatch[1] ?? ''
    const identityType = videoPreviewMatch[2]
    const identityValue = videoPreviewMatch[3]
    const equivalentType = identityType === 'video-id' ? 'preview-id' : 'video-id'
    return [`${prefix}${equivalentType}:${identityValue}`]
  }

  return []
}

function createEquivalentItemIds(
  siteId: string,
  url: string,
  title: string,
  dedupeKey: string | undefined,
): string[] {
  return getEquivalentDedupeKeys(siteId, dedupeKey).map((equivalentDedupeKey) =>
    createItemId(siteId, url, title, equivalentDedupeKey),
  )
}

function normalizeParsedItem(
  siteId: string,
  item: ParsedItem,
  crawledAt: number,
): NormalizedCrawledItem | null {
  const title = item.title.trim()
  const url = normalizeUrl(item.url)

  if (!title || !url) {
    return null
  }

  const normalizedItem: CrawledItem = {
    id: createItemId(siteId, url, title, item.dedupeKey),
    siteId,
    title,
    url,
    previewImageUrl: normalizePreviewImageUrl(item.previewImageUrl),
    summary: item.summary?.trim() || undefined,
    price: item.price,
    rawHtmlSnippet: clipSnippet(item.rawHtmlSnippet),
    crawledAt,
  }

  return {
    item: normalizedItem,
    equivalentItemIds: createEquivalentItemIds(siteId, url, title, item.dedupeKey),
    stableFingerprints: createStableFingerprints({
      ...normalizedItem,
      dedupeKey: item.dedupeKey,
    }),
  }
}

export async function upsertCrawledItems(
  siteId: string,
  items: ParsedItem[],
  crawledAt = Date.now(),
): Promise<UpsertCrawledItemsResult> {
  const normalized = items
    .map((item) => normalizeParsedItem(siteId, item, crawledAt))
    .filter((item): item is NormalizedCrawledItem => item !== null)
  const dedupedNormalized = dedupeByItemId(normalized)
  const itemIds = dedupedNormalized.map(({ item }) => item.id)

  if (dedupedNormalized.length === 0) {
    return {
      items: [],
      insertedCount: 0,
      skippedCount: 0,
    }
  }

  const existingLogs = await db.crawledItemLogs.bulkGet(itemIds)
  const existingItems = await db.items.bulkGet(itemIds)
  const equivalentItemIds = Array.from(
    new Set(dedupedNormalized.flatMap((item) => item.equivalentItemIds)),
  )
  const equivalentLogs =
    equivalentItemIds.length > 0
      ? await db.crawledItemLogs.bulkGet(equivalentItemIds)
      : []
  const equivalentItems =
    equivalentItemIds.length > 0 ? await db.items.bulkGet(equivalentItemIds) : []
  const existingItemByStableFingerprint = await listExistingItemsByStableFingerprint(
    siteId,
    dedupedNormalized,
  )
  const stableFingerprintItemIds = Array.from(
    new Set(
      [...existingItemByStableFingerprint.values()].map((item) => item.id),
    ),
  )
  const stableFingerprintItemLogs =
    stableFingerprintItemIds.length > 0
      ? await db.crawledItemLogs.bulkGet(stableFingerprintItemIds)
      : []
  const existingLogById = new Map<string, CrawledItemLog>()
  for (const log of existingLogs) {
    if (log) {
      existingLogById.set(log.id, log)
    }
  }
  for (const log of equivalentLogs) {
    if (log) {
      existingLogById.set(log.id, log)
    }
  }
  for (const log of stableFingerprintItemLogs) {
    if (log) {
      existingLogById.set(log.id, log)
    }
  }
  const existingItemById = new Map<string, CrawledItem>()
  for (const existingItem of existingItems) {
    if (existingItem) {
      existingItemById.set(existingItem.id, existingItem)
    }
  }
  for (const existingItem of equivalentItems) {
    if (existingItem) {
      existingItemById.set(existingItem.id, existingItem)
    }
  }
  for (const existingItem of existingItemByStableFingerprint.values()) {
    existingItemById.set(existingItem.id, existingItem)
  }

  const freshItems: CrawledItem[] = []
  const logsToWrite: CrawledItemLog[] = []

  for (const normalizedItem of dedupedNormalized) {
    const { item } = normalizedItem
    const existingLog =
      existingLogById.get(item.id) ??
      normalizedItem.equivalentItemIds
        .map((equivalentItemId) => existingLogById.get(equivalentItemId))
        .find((equivalentLog): equivalentLog is CrawledItemLog =>
          Boolean(equivalentLog),
        )

    if (!existingLog) {
      const existingItem =
        existingItemById.get(item.id) ??
        normalizedItem.equivalentItemIds
          .map((equivalentItemId) => existingItemById.get(equivalentItemId))
          .find((equivalentItem): equivalentItem is CrawledItem =>
            Boolean(equivalentItem),
          ) ??
        normalizedItem.stableFingerprints
          .map((stableFingerprint) =>
            existingItemByStableFingerprint.get(stableFingerprint),
          )
          .find((stableItem): stableItem is CrawledItem => Boolean(stableItem))

      if (existingItem) {
        const sourceLog = existingLogById.get(existingItem.id)

        logsToWrite.push({
          id: item.id,
          siteId: existingItem.siteId,
          itemId: existingItem.id,
          firstSeenAt: sourceLog?.firstSeenAt ?? existingItem.crawledAt,
          lastSeenAt: crawledAt,
          seenCount: (sourceLog?.seenCount ?? 1) + 1,
        })
        continue
      }

      freshItems.push(item)
      logsToWrite.push(createItemLog(item))
      continue
    }

    logsToWrite.push({
      ...existingLog,
      lastSeenAt: crawledAt,
      seenCount: existingLog.seenCount + 1,
    })
  }

  await db.transaction('rw', db.items, db.crawledItemLogs, async () => {
    if (freshItems.length > 0) {
      await db.items.bulkPut(freshItems)
    }
    await db.crawledItemLogs.bulkPut(logsToWrite)
  })

  const insertedCount = freshItems.length
  const skippedCount = dedupedNormalized.length - insertedCount

  return {
    items: freshItems,
    insertedCount,
    skippedCount,
  }
}

export async function listItemsBySite(
  siteId: string,
  limit = 200,
): Promise<CrawledItem[]> {
  return db.items
    .where('[siteId+crawledAt]')
    .between([siteId, Dexie.minKey], [siteId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export async function listItemCountsBySite(
  siteIds: readonly string[],
): Promise<Record<string, number>> {
  const counts = await Promise.all(
    siteIds.map(async (siteId) => {
      const count = await db.items.where('siteId').equals(siteId).count()
      return [siteId, count] as const
    }),
  )

  return Object.fromEntries(counts)
}

export async function deleteCrawledItem(itemId: string): Promise<void> {
  await db.items.delete(itemId)
}

export async function saveCrawlRun(run: CrawlRun): Promise<void> {
  await db.crawlRuns.put(run)
}

export async function listCrawlRunsBySite(
  siteId: string,
  limit = 20,
): Promise<CrawlRun[]> {
  return db.crawlRuns
    .where('[siteId+startedAt]')
    .between([siteId, Dexie.minKey], [siteId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export async function clearAllData(): Promise<void> {
  await db.transaction('rw', db.items, db.crawlRuns, db.crawledItemLogs, async () => {
    await db.items.clear()
    await db.crawlRuns.clear()
    await db.crawledItemLogs.clear()
  })
}
