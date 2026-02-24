import Dexie from 'dexie'
import type { CrawledItem, CrawlRun, ParsedItem } from '../types/contracts'
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
  updatedCount: number
}

export function createItemId(siteId: string, url: string, title: string): string {
  const normalized = `${normalizeUrl(url).toLowerCase()}|${title.trim().toLowerCase()}`
  return `${siteId}:${hashString(normalized)}`
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
    id: createItemId(siteId, url, title),
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

  if (dedupedNormalized.length === 0) {
    return {
      items: [],
      insertedCount: 0,
      updatedCount: 0,
    }
  }

  const existingItems = await db.items.bulkGet(dedupedNormalized.map((item) => item.id))
  const updatedCount = existingItems.filter((item) => item !== undefined).length
  const insertedCount = dedupedNormalized.length - updatedCount

  await db.items.bulkPut(dedupedNormalized)
  return {
    items: dedupedNormalized,
    insertedCount,
    updatedCount,
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
  await db.transaction('rw', db.items, db.crawlRuns, async () => {
    await db.items.clear()
    await db.crawlRuns.clear()
  })
}
