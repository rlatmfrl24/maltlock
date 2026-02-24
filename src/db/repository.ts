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
): Promise<CrawledItem[]> {
  const normalized = items
    .map((item) => normalizeParsedItem(siteId, item, crawledAt))
    .filter((item): item is CrawledItem => item !== null)

  if (normalized.length === 0) {
    return []
  }

  await db.items.bulkPut(normalized)
  return normalized
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
