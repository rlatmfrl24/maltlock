import Dexie from 'dexie'
import type {
  AppMeta,
  CrawledItem,
  CrawledItemLog,
  CrawlDiagnosticArtifact,
  CrawlRun,
  ItemIdentity,
  ItemSignature,
  ParsedItem,
  NimiPlatform,
} from '../types/contracts'
import { getItemSourcePlatform, isNimiPlatform } from '../extension/nimi'
import { hashString } from '../utils/hash'
import {
  createItemSignatures,
  normalizeItemIdentities,
  recoverItemIdentities,
  sharesExactIdentity,
} from './item-identities'
import { db } from './schema'

const MAX_SNIPPET_LENGTH = 280
const BACKFILL_META_KEY = 'item-signature-backfill-v1'
const BACKFILL_VERSION = 1
const DEDUPE_MEDIA_ID_REGEX = /(?:^|:)(?:video-id|preview-id):([^:\s]+)$/i
const DEDUPE_TWEET_STATUS_ID_REGEX = /(?:^|:)tweet-status:(\d+)$/i
const DEDUPE_PATH_REGEX = /(?:^|:)path:(\/.*)$/i
const DEDUPE_VIDEO_PREVIEW_KEY_REGEX = /^(.+:)(video-id|preview-id):([^:\s]+)$/i

interface NormalizedCrawledItem {
  item: CrawledItem
  signatures: ItemSignature[]
  equivalentItemIds: string[]
  legacyFingerprintLogIds: string[]
}

export interface UpsertCrawledItemsResult {
  items: CrawledItem[]
  validCount: number
  insertedCount: number
  duplicateCount: number
  exactDuplicateCount: number
  rejectedCount: number
}

export interface ItemBackfillProgress {
  version: number
  cursor?: string
  processed: number
  total: number
  complete: boolean
}

function normalizeUrl(input: string): string {
  try {
    return new URL(input).toString()
  } catch {
    return input.trim()
  }
}

function normalizePreviewImageUrl(input: string | undefined): string | undefined {
  const trimmed = input?.trim()
  if (!trimmed || trimmed.startsWith('data:')) return undefined
  return normalizeUrl(trimmed)
}

function clipSnippet(input: string | undefined): string | undefined {
  const normalized = input?.trim()
  if (!normalized) return undefined
  return normalized.length <= MAX_SNIPPET_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SNIPPET_LENGTH - 3)}...`
}

function isSupportedItemUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeDedupeKey(input: string | undefined): string | undefined {
  const normalized = input?.trim().toLowerCase()
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

function identitiesFromDedupeKey(dedupeKey: string | undefined): ItemIdentity[] {
  const normalized = normalizeDedupeKey(dedupeKey)
  if (!normalized) return []
  const mediaId = normalized.match(DEDUPE_MEDIA_ID_REGEX)?.[1]
  if (mediaId) return [{ kind: 'media-id', value: `video:${mediaId}`, scope: 'global' }]
  const tweetId = normalized.match(DEDUPE_TWEET_STATUS_ID_REGEX)?.[1]
  if (tweetId) return [{ kind: 'media-id', value: `tweet:${tweetId}`, scope: 'global' }]
  const path = normalized.match(DEDUPE_PATH_REGEX)?.[1]
  if (path) return [{ kind: 'canonical-url', value: path, scope: 'site' }]
  return []
}

function getEquivalentDedupeKeys(dedupeKey: string | undefined): string[] {
  const normalized = normalizeDedupeKey(dedupeKey)
  const match = normalized?.match(DEDUPE_VIDEO_PREVIEW_KEY_REGEX)
  if (!match) return []
  const equivalentType = match[2] === 'video-id' ? 'preview-id' : 'video-id'
  return [`${match[1]}${equivalentType}:${match[3]}`]
}

function legacyFingerprintValues(item: CrawledItem): string[] {
  const values = new Set<string>()
  for (const input of [item.url, item.previewImageUrl, item.summary]) {
    if (!input) continue
    try {
      const parsed = new URL(input)
      parsed.searchParams.sort()
      if (parsed.pathname !== '/') {
        const search = parsed.searchParams.toString()
        values.add(
          `url-path:${parsed.pathname.toLowerCase()}${search ? `?${search}` : ''}`,
        )
      }
    } catch {
      // Legacy fallback ignores invalid URLs.
    }
    const mediaId = input.match(
      /\/(?:amplify_video|ext_tw_video|amplify_video_thumb|ext_tw_video_thumb)\/(\d+)/i,
    )?.[1]
    if (mediaId) values.add(`media-id:${mediaId}`)
  }
  return item.siteId === 'nimi-tw-ranking' && item.sourcePlatform && item.sourcePlatform !== 'tw'
    ? [...values].map((value) => `nimi:${item.sourcePlatform}:${value}`) : [...values]
}

function legacyLogId(siteId: string, value: string): string {
  return `${siteId}:stable:${hashString(value)}`
}

function normalizeParsedItem(
  siteId: string,
  parsed: ParsedItem,
  crawledAt: number,
): NormalizedCrawledItem | null {
  const title = parsed.title.trim()
  const url = normalizeUrl(parsed.url)
  if (!title || !isSupportedItemUrl(url)) return null

  const baseForRecovery = {
    title,
    url,
    previewImageUrl: normalizePreviewImageUrl(parsed.previewImageUrl),
    summary: parsed.summary?.trim() || undefined,
  }
  const identities = normalizeItemIdentities([
    ...(parsed.identities ?? []),
    ...identitiesFromDedupeKey(parsed.dedupeKey),
    ...(parsed.identities?.length ? [] : recoverItemIdentities(baseForRecovery)),
  ])
  const item: CrawledItem = {
    id: createItemId(siteId, url, title, parsed.dedupeKey),
    siteId,
    title,
    url,
    dedupeKey: normalizeDedupeKey(parsed.dedupeKey),
    identities,
    previewImageUrl: baseForRecovery.previewImageUrl,
    summary: baseForRecovery.summary,
    price: parsed.price,
    rawHtmlSnippet: clipSnippet(parsed.rawHtmlSnippet),
    crawledAt,
    sourcePlatform: siteId === 'nimi-tw-ranking' && isNimiPlatform(parsed.sourcePlatform) ? parsed.sourcePlatform : undefined,
  }
  const legacyValues = legacyFingerprintValues(item)
  return {
    item,
    signatures: createItemSignatures(item),
    equivalentItemIds: getEquivalentDedupeKeys(parsed.dedupeKey).map((key) =>
      createItemId(siteId, url, title, key),
    ),
    legacyFingerprintLogIds: legacyValues.map((value) => legacyLogId(siteId, value)),
  }
}

function signatureLookupKey(signature: ItemSignature): string {
  return `${signature.scope}:${signature.kind}:${signature.valueHash}`
}

function isExactSignature(signature: ItemSignature): boolean {
  return signature.kind !== 'title-exact' && signature.kind !== 'title-band' && signature.kind !== 'preview'
}

async function loadMatchingSignatures(
  signatures: readonly ItemSignature[],
): Promise<Map<string, ItemSignature[]>> {
  const result = new Map<string, ItemSignature[]>()
  const unique = new Map(signatures.map((signature) => [signatureLookupKey(signature), signature]))
  await Promise.all(
    [...unique.values()].map(async (signature) => {
      const matches = await db.itemSignatures
        .where('[scope+kind+valueHash]')
        .equals([signature.scope, signature.kind, signature.valueHash])
        .toArray()
      result.set(signatureLookupKey(signature), matches)
    }),
  )
  return result
}

function createOrUpdateLog(
  existing: CrawledItemLog | undefined,
  sourceItem: CrawledItem,
  observedItemId: string,
  crawledAt: number,
): CrawledItemLog {
  return existing
    ? { ...existing, lastSeenAt: crawledAt, seenCount: existing.seenCount + 1 }
    : {
        id: observedItemId,
        siteId: sourceItem.siteId,
        itemId: sourceItem.id,
        firstSeenAt: sourceItem.crawledAt,
        lastSeenAt: crawledAt,
        seenCount: 2,
      }
}

export async function upsertCrawledItems(
  siteId: string,
  parsedItems: ParsedItem[],
  crawledAt = Date.now(),
): Promise<UpsertCrawledItemsResult> {
  const normalized = parsedItems
    .map((item) => normalizeParsedItem(siteId, item, crawledAt))
    .filter((item): item is NormalizedCrawledItem => Boolean(item))
  const byId = new Map<string, NormalizedCrawledItem>()
  for (const item of normalized) byId.set(item.item.id, item)
  const candidates = [...byId.values()]
  const inBatchDuplicateCount = normalized.length - candidates.length

  if (candidates.length === 0) {
    return {
      items: [],
      validCount: normalized.length,
      insertedCount: 0,
      duplicateCount: 0,
      exactDuplicateCount: 0,
      rejectedCount: parsedItems.length - normalized.length,
    }
  }

  const exactSignatures = candidates.flatMap((candidate) =>
    candidate.signatures.filter(isExactSignature),
  )
  const matchingSignatures = await loadMatchingSignatures(exactSignatures)
  const matchedItemIds = new Set(
    [...matchingSignatures.values()].flat().map((signature) => signature.itemId),
  )
  const directIds = candidates.flatMap((candidate) => [
    candidate.item.id,
    ...candidate.equivalentItemIds,
  ])
  const existingItems = (await db.items.bulkGet([...new Set([...directIds, ...matchedItemIds])])).filter(
    (item): item is CrawledItem => Boolean(item),
  )
  const existingItemsById = new Map(existingItems.map((item) => [item.id, item]))
  const logIds = candidates.flatMap((candidate) => [
    candidate.item.id,
    ...candidate.equivalentItemIds,
    ...candidate.legacyFingerprintLogIds,
  ])
  const logs = (await db.crawledItemLogs.bulkGet([...new Set(logIds)])).filter(
    (log): log is CrawledItemLog => Boolean(log),
  )
  const logsById = new Map(logs.map((log) => [log.id, log]))

  const backfill = await getItemBackfillProgress()
  const legacyItems = backfill.complete
    ? []
    : await db.items.where('siteId').equals(siteId).toArray()
  const freshItems: CrawledItem[] = []
  const signaturesToWrite: ItemSignature[] = []
  const logsToWrite = new Map<string, CrawledItemLog>()
  const batchExact = new Map<string, CrawledItem>()
  let exactDuplicateCount = inBatchDuplicateCount

  await db.transaction('rw', db.items, db.itemSignatures, db.crawledItemLogs, async () => {
    for (const candidate of candidates) {
      const item = candidate.item
      const exactMatches = candidate.signatures
        .filter(isExactSignature)
        .flatMap((signature) => matchingSignatures.get(signatureLookupKey(signature)) ?? [])
      const exactItems = (await db.items.bulkGet([...new Set(exactMatches.map((match) => match.itemId))])).filter(
        (value): value is CrawledItem => Boolean(value),
      )
      const sameSiteExact = exactItems.find((value) => value.siteId === siteId)
      const batchMatch = candidate.signatures
        .filter(isExactSignature)
        .map((signature) => batchExact.get(signatureLookupKey(signature)))
        .find((value): value is CrawledItem => Boolean(value))
      const directItem = [item.id, ...candidate.equivalentItemIds]
        .map((id) => existingItemsById.get(id))
        .find((value): value is CrawledItem => Boolean(value))
      let directLog = [item.id, ...candidate.equivalentItemIds, ...candidate.legacyFingerprintLogIds]
        .map((id) => logsById.get(id))
        .find((value): value is CrawledItemLog => Boolean(value))
      const legacyMatch = legacyItems.find((legacy) => {
        const legacyValues = new Set(legacyFingerprintValues(legacy))
        return legacyFingerprintValues(item).some((value) => legacyValues.has(value))
      })
      const duplicateSource = sameSiteExact ?? batchMatch ?? directItem ?? legacyMatch

      // Older heuristic matches may have logged a different post as already collected.
      if (directLog && !duplicateSource && directLog.itemId !== item.id) {
        const loggedItem = await db.items.get(directLog.itemId)
        const hasSourceId = (value: CrawledItem) => value.identities?.some(
          (identity) => identity.kind === 'source-id' && identity.scope === 'site',
        )
        if (loggedItem && hasSourceId(item) && hasSourceId(loggedItem) && !sharesExactIdentity(item, loggedItem)) {
          directLog = undefined
        }
      }

      if (duplicateSource || directLog) {
        exactDuplicateCount += 1
        const source = duplicateSource ?? existingItemsById.get(directLog?.itemId ?? '') ?? item
        const sourceLog = directLog ?? (source.id !== item.id
          ? await db.crawledItemLogs.get(source.id)
          : undefined)
        const observedLogId = directLog?.id ?? item.id
        logsToWrite.set(observedLogId, sourceLog
          ? {
              ...sourceLog,
              id: observedLogId,
              itemId: source.id,
              lastSeenAt: crawledAt,
              seenCount: sourceLog.seenCount + 1,
            }
          : createOrUpdateLog(undefined, source, observedLogId, crawledAt))

        if (duplicateSource && (item.previewImageUrl || item.sourcePlatform)) {
          const refresh = {
            ...(item.previewImageUrl ? { previewImageUrl: item.previewImageUrl } : {}),
            ...(siteId === 'nimi-tw-ranking' && item.sourcePlatform ? {
              sourcePlatform: item.sourcePlatform, url: item.url,
              ...(item.summary ? { summary: item.summary } : {}),
            } : {}),
          }
          if (batchMatch?.id === duplicateSource.id) {
            const refreshedBatchItem = {
              ...batchMatch,
              ...refresh,
            }
            const freshIndex = freshItems.findIndex(
              (freshItem) => freshItem.id === refreshedBatchItem.id,
            )
            if (freshIndex >= 0) freshItems[freshIndex] = refreshedBatchItem
            for (const [key, value] of batchExact) {
              if (value.id === refreshedBatchItem.id) {
                batchExact.set(key, refreshedBatchItem)
              }
            }
          } else {
            const currentSource = await db.items.get(duplicateSource.id)
            if (currentSource && Object.entries(refresh).some(([key, value]) => currentSource[key as keyof CrawledItem] !== value)) {
              await db.items.put({
                ...currentSource,
                ...refresh,
              })
            }
          }
        }
        continue
      }

      freshItems.push(item)
      signaturesToWrite.push(...candidate.signatures)
      logsToWrite.set(item.id, {
        id: item.id,
        siteId,
        itemId: item.id,
        firstSeenAt: crawledAt,
        lastSeenAt: crawledAt,
        seenCount: 1,
      })
      for (const legacyId of candidate.legacyFingerprintLogIds) {
        logsToWrite.set(legacyId, {
          id: legacyId,
          siteId,
          itemId: item.id,
          firstSeenAt: crawledAt,
          lastSeenAt: crawledAt,
          seenCount: 1,
        })
      }
      for (const signature of candidate.signatures.filter(isExactSignature)) {
        batchExact.set(signatureLookupKey(signature), item)
      }
    }

    if (freshItems.length > 0) await db.items.bulkPut(freshItems)
    if (signaturesToWrite.length > 0) await db.itemSignatures.bulkPut(signaturesToWrite)
    if (logsToWrite.size > 0) await db.crawledItemLogs.bulkPut([...logsToWrite.values()])
  })

  const insertedCount = freshItems.length
  return {
    items: freshItems,
    validCount: normalized.length,
    insertedCount,
    duplicateCount: exactDuplicateCount,
    exactDuplicateCount,
    rejectedCount: parsedItems.length - normalized.length,
  }
}

export async function listItemsBySite(siteId: string, limit = 200, sourcePlatform?: NimiPlatform): Promise<CrawledItem[]> {
  const query = db.items
    .where('[siteId+crawledAt]')
    .between([siteId, Dexie.minKey], [siteId, Dexie.maxKey])
    .reverse()
  // ponytail: filter optional legacy metadata before limiting; index only if large libraries make this slow.
  return (sourcePlatform ? query.filter((item) => getItemSourcePlatform(item) === sourcePlatform) : query).limit(limit).toArray()
}

export async function listItemCountsBySite(siteIds: readonly string[]): Promise<Record<string, number>> {
  return Object.fromEntries(await Promise.all(siteIds.map(async (siteId) => [siteId, await countCrawledItems(siteId)])))
}

export async function deleteCrawledItem(itemId: string): Promise<void> {
  await deleteCrawledItems([itemId])
}

export async function listCrawledItemIds(siteId?: string, sourcePlatform?: NimiPlatform): Promise<string[]> {
  const query = siteId ? db.items.where('siteId').equals(siteId) : db.items.toCollection()
  return sourcePlatform ? query.filter((item) => getItemSourcePlatform(item) === sourcePlatform).primaryKeys() : query.primaryKeys()
}

export async function countCrawledItems(siteId?: string, sourcePlatform?: NimiPlatform): Promise<number> {
  const query = siteId ? db.items.where('siteId').equals(siteId) : db.items.toCollection()
  return (sourcePlatform ? query.filter((item) => getItemSourcePlatform(item) === sourcePlatform) : query).count()
}

export async function deleteCrawledItems(itemIds: readonly string[]): Promise<string[]> {
  return db.transaction('rw', db.items, db.itemSignatures, async () => {
    const existing = (await db.items.bulkGet([...new Set(itemIds)])).filter((item): item is CrawledItem => !!item)
    const ids = existing.map((item) => item.id)
    await db.items.bulkDelete(ids)
    await db.itemSignatures.where('itemId').anyOf(ids).delete()
    // Keep seen logs so intentionally deleted articles are not collected again.
    return ids
  })
}

export async function saveCrawlRun(run: CrawlRun): Promise<void> {
  await db.crawlRuns.put(run)
}

export async function listCrawlRunsBySite(siteId: string, limit = 20): Promise<CrawlRun[]> {
  return db.crawlRuns
    .where('[siteId+startedAt]')
    .between([siteId, Dexie.minKey], [siteId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export async function getCrawlDiagnostic(runId: string): Promise<CrawlDiagnosticArtifact | undefined> {
  return db.crawlDiagnostics.get(runId)
}

export async function saveCrawlDiagnostic(
  artifact: CrawlDiagnosticArtifact,
  options: { maxPerSite: number; maxAgeMs: number },
): Promise<void> {
  const oldestAllowedAt = artifact.createdAt - options.maxAgeMs
  await db.transaction('rw', db.crawlDiagnostics, async () => {
    await db.crawlDiagnostics.put(artifact)
    await db.crawlDiagnostics.where('createdAt').below(oldestAllowedAt).delete()
    const siteArtifacts = await db.crawlDiagnostics
      .where('[siteId+createdAt]')
      .between([artifact.siteId, Dexie.minKey], [artifact.siteId, Dexie.maxKey])
      .reverse()
      .toArray()
    await db.crawlDiagnostics.bulkDelete(siteArtifacts.slice(options.maxPerSite).map((item) => item.runId))
  })
}

export async function getItemBackfillProgress(): Promise<ItemBackfillProgress> {
  const meta = await db.appMeta.get(BACKFILL_META_KEY)
  if (meta?.value && typeof meta.value === 'object') return meta.value as ItemBackfillProgress
  return { version: BACKFILL_VERSION, processed: 0, total: await db.items.count(), complete: false }
}

export async function runItemSignatureBackfillBatch(batchSize = 100): Promise<ItemBackfillProgress> {
  const progress = await getItemBackfillProgress()
  if (progress.complete && progress.version === BACKFILL_VERSION) return progress
  const allItems = await db.items.orderBy('crawledAt').toArray()
  const startIndex = progress.cursor
    ? Math.max(0, allItems.findIndex((item) => item.id === progress.cursor) + 1)
    : 0
  const batch = allItems.slice(startIndex, startIndex + batchSize)
  const updates = batch.map((item) => ({
    ...item,
    identities: normalizeItemIdentities(item.identities?.length ? item.identities : recoverItemIdentities(item)),
  }))
  const signatures = updates.flatMap(createItemSignatures)
  const processed = Math.min(allItems.length, startIndex + batch.length)
  const next: ItemBackfillProgress = {
    version: BACKFILL_VERSION,
    cursor: batch.at(-1)?.id ?? progress.cursor,
    processed,
    total: allItems.length,
    complete: processed >= allItems.length,
  }
  const meta: AppMeta = { key: BACKFILL_META_KEY, value: next, updatedAt: Date.now() }
  await db.transaction('rw', db.items, db.itemSignatures, db.appMeta, async () => {
    // A deletion may have committed while this batch was being prepared.
    const liveIds = new Set((await db.items.bulkGet(updates.map((item) => item.id)))
      .filter((item): item is CrawledItem => !!item).map((item) => item.id))
    const liveUpdates = updates.filter((item) => liveIds.has(item.id))
    const liveSignatures = signatures.filter((signature) => liveIds.has(signature.itemId))
    if (liveUpdates.length > 0) await db.items.bulkPut(liveUpdates)
    if (liveSignatures.length > 0) await db.itemSignatures.bulkPut(liveSignatures)
    await db.appMeta.put(meta)
  })
  return next
}

export async function clearAllData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.items,
      db.crawlRuns,
      db.crawledItemLogs,
      db.crawlDiagnostics,
      db.itemSignatures,
      db.appMeta,
    ],
    async () => {
      await Promise.all([
        db.items.clear(),
        db.crawlRuns.clear(),
        db.crawledItemLogs.clear(),
        db.crawlDiagnostics.clear(),
        db.itemSignatures.clear(),
        db.appMeta.clear(),
      ])
    },
  )
}
