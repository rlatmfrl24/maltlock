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

function dedupeByItemId(items: CrawledItem[]): CrawledItem[] {
  const deduped = new Map<string, CrawledItem>()

  for (const item of items) {
    // Keep the latest value when the same id appears multiple times in one crawl batch.
    deduped.set(item.id, item)
  }

  return [...deduped.values()]
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

function normalizeParsedItem(
  siteId: string,
  item: ParsedItem,
  crawledAt: number,
): CrawledItem | null {
  const title = item.title.trim()
  const url = normalizeUrl(item.url)

  if (!title || !url) {
    return null
  }

  return {
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
}

export async function upsertCrawledItems(
  siteId: string,
  items: ParsedItem[],
  crawledAt = Date.now(),
): Promise<UpsertCrawledItemsResult> {
  const normalized = items
    .map((item) => normalizeParsedItem(siteId, item, crawledAt))
    .filter((item): item is CrawledItem => item !== null)
  const dedupedNormalized = dedupeByItemId(normalized)
  const itemIds = dedupedNormalized.map((item) => item.id)

  if (dedupedNormalized.length === 0) {
    return {
      items: [],
      insertedCount: 0,
      skippedCount: 0,
    }
  }

  const existingLogs = await db.crawledItemLogs.bulkGet(itemIds)
  const existingItems = await db.items.bulkGet(itemIds)
  const existingLogById = new Map<string, CrawledItemLog>()
  for (const log of existingLogs) {
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

  const freshItems: CrawledItem[] = []
  const logsToWrite: CrawledItemLog[] = []

  for (const item of dedupedNormalized) {
    const existingLog = existingLogById.get(item.id)

    if (!existingLog) {
      const existingItem = existingItemById.get(item.id)
      if (existingItem) {
        logsToWrite.push({
          id: existingItem.id,
          siteId: existingItem.siteId,
          itemId: existingItem.id,
          firstSeenAt: existingItem.crawledAt,
          lastSeenAt: crawledAt,
          seenCount: 2,
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
