import Dexie from 'dexie'
import type {
  AppMeta,
  CrawledItem,
  CrawledItemLog,
  CrawlDiagnosticArtifact,
  CrawlRun,
  ItemCountSummary,
  ItemGroup,
  ItemIdentity,
  ItemSignature,
  ParsedItem,
} from '../types/contracts'
import { hashString } from '../utils/hash'
import {
  createItemSignatures,
  matchSimilarItems,
  normalizeItemIdentities,
  normalizeTitleForSimilarity,
  recoverItemIdentities,
  sharesExactIdentity,
} from './item-similarity'
import { db } from './schema'

const MAX_SNIPPET_LENGTH = 280
const MAX_SIMILARITY_CANDIDATES = 100
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
  similarGroupedCount: number
  uniqueInsertedCount: number
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
  return [...values]
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
    ...recoverItemIdentities(baseForRecovery),
  ])
  const item: CrawledItem = {
    id: createItemId(siteId, url, title, parsed.dedupeKey),
    siteId,
    title,
    url,
    dedupeKey: normalizeDedupeKey(parsed.dedupeKey),
    identities,
    normalizedTitle: normalizeTitleForSimilarity(title),
    previewImageUrl: baseForRecovery.previewImageUrl,
    summary: baseForRecovery.summary,
    price: parsed.price,
    rawHtmlSnippet: clipSnippet(parsed.rawHtmlSnippet),
    crawledAt,
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

async function loadSimilarityCandidates(
  siteId: string,
  signatures: readonly ItemSignature[],
): Promise<CrawledItem[]> {
  const titleSignatures = signatures.filter(
    (signature) => signature.kind === 'title-exact' || signature.kind === 'title-band',
  )
  const matches = await Promise.all(
    titleSignatures.map((signature) =>
      db.itemSignatures
        .where('[siteId+kind+valueHash]')
        .equals([siteId, signature.kind, signature.valueHash])
        .limit(MAX_SIMILARITY_CANDIDATES)
        .toArray(),
    ),
  )
  const itemIds = [...new Set(matches.flat().map((signature) => signature.itemId))].slice(
    0,
    MAX_SIMILARITY_CANDIDATES,
  )
  const items = itemIds.length > 0 ? await db.items.bulkGet(itemIds) : []
  return items.filter((item): item is CrawledItem => Boolean(item))
}

function chooseRepresentative(items: readonly CrawledItem[]): CrawledItem {
  return [...items].sort((first, second) => {
    const preview = Number(Boolean(second.previewImageUrl)) - Number(Boolean(first.previewImageUrl))
    if (preview !== 0) return preview
    const summary = Number(Boolean(second.summary)) - Number(Boolean(first.summary))
    if (summary !== 0) return summary
    return second.crawledAt - first.crawledAt
  })[0] as CrawledItem
}

function oldestGroupId(items: readonly CrawledItem[]): string | undefined {
  const oldest = [...items].sort((a, b) => a.crawledAt - b.crawledAt || a.id.localeCompare(b.id))[0]
  return oldest ? oldest.contentGroupId ?? `item:${oldest.id}` : undefined
}

async function resolveOldestGroupId(items: readonly CrawledItem[]): Promise<string | undefined> {
  const groupIds = [...new Set(items.map((item) => item.contentGroupId).filter(Boolean))] as string[]
  const groupMembers = (
    await Promise.all(groupIds.map((groupId) => db.items.where('contentGroupId').equals(groupId).toArray()))
  ).flat()
  return oldestGroupId([...items, ...groupMembers])
}

async function mergeGroups(groupIds: readonly string[], targetGroupId: string): Promise<void> {
  const oldIds = [...new Set(groupIds.filter((groupId) => groupId !== targetGroupId))]
  for (const oldId of oldIds) {
    const members = await db.items.where('contentGroupId').equals(oldId).toArray()
    if (members.length > 0) {
      await db.items.bulkPut(members.map((item) => ({ ...item, contentGroupId: targetGroupId })))
    }
  }
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
      similarGroupedCount: 0,
      uniqueInsertedCount: 0,
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
  let similarGroupedCount = 0

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
      const directLog = [item.id, ...candidate.equivalentItemIds, ...candidate.legacyFingerprintLogIds]
        .map((id) => logsById.get(id))
        .find((value): value is CrawledItemLog => Boolean(value))
      const legacyMatch = legacyItems.find((legacy) => {
        const legacyValues = new Set(legacyFingerprintValues(legacy))
        return legacyFingerprintValues(item).some((value) => legacyValues.has(value))
      })
      const duplicateSource = sameSiteExact ?? batchMatch ?? directItem ?? legacyMatch

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

        const bridgeItems = [...exactItems, ...(batchMatch ? [batchMatch] : [])]
        if (bridgeItems.length > 1) {
          const targetGroupId = await resolveOldestGroupId(bridgeItems)
          if (targetGroupId) {
            await mergeGroups(
              bridgeItems.map((value) => value.contentGroupId ?? `item:${value.id}`),
              targetGroupId,
            )
            await db.items.bulkPut(
              bridgeItems.map((value) => ({
                ...value,
                contentGroupId: targetGroupId,
                groupReason: 'global-identity' as const,
                groupScore: 1,
              })),
            )
          }
        }

        if (duplicateSource && item.previewImageUrl) {
          if (batchMatch?.id === duplicateSource.id) {
            const refreshedBatchItem = {
              ...batchMatch,
              previewImageUrl: item.previewImageUrl,
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
            const currentSource = (await db.items.get(duplicateSource.id)) ?? duplicateSource
            if (currentSource.previewImageUrl !== item.previewImageUrl) {
              await db.items.put({
                ...currentSource,
                previewImageUrl: item.previewImageUrl,
              })
            }
          }
        }
        continue
      }

      const globalMatches = exactItems.filter((value) => value.siteId !== siteId)
      let storedItem = item
      if (globalMatches.length > 0) {
        const groupId =
          (await resolveOldestGroupId(globalMatches)) ?? `item:${globalMatches[0]?.id}`
        storedItem = {
          ...storedItem,
          contentGroupId: groupId,
          groupReason: 'global-identity',
          groupScore: 1,
        }
        await mergeGroups(
          globalMatches.map((value) => value.contentGroupId ?? `item:${value.id}`),
          groupId,
        )
        await db.items.bulkPut(
          globalMatches.map((value) => ({
            ...value,
            contentGroupId: groupId,
            groupReason: 'global-identity' as const,
            groupScore: 1,
          })),
        )
      } else {
        const dbSimilarityCandidates = await loadSimilarityCandidates(siteId, candidate.signatures)
        const similarityCandidates = [...dbSimilarityCandidates, ...freshItems].slice(
          0,
          MAX_SIMILARITY_CANDIDATES,
        )
        const matched = similarityCandidates
          .map((value) => ({ value, match: matchSimilarItems(item, value) }))
          .filter((entry): entry is { value: CrawledItem; match: NonNullable<typeof entry.match> } => Boolean(entry.match))
          .sort((a, b) => b.match.score - a.match.score)[0]
        if (matched) {
          const groupId = matched.value.contentGroupId ?? `item:${matched.value.id}`
          storedItem = {
            ...storedItem,
            contentGroupId: groupId,
            groupReason: matched.match.reason,
            groupScore: matched.match.score,
          }
          similarGroupedCount += 1
          if (!matched.value.contentGroupId) {
            const groupedCandidate = {
              ...matched.value,
              contentGroupId: groupId,
              groupReason: matched.match.reason,
              groupScore: matched.match.score,
            }
            await db.items.put(groupedCandidate)
            const index = freshItems.findIndex((value) => value.id === groupedCandidate.id)
            if (index >= 0) freshItems[index] = groupedCandidate
          }
        }
      }

      freshItems.push(storedItem)
      const storedSignatures = createItemSignatures(storedItem)
      signaturesToWrite.push(...storedSignatures)
      logsToWrite.set(storedItem.id, {
        id: storedItem.id,
        siteId,
        itemId: storedItem.id,
        firstSeenAt: crawledAt,
        lastSeenAt: crawledAt,
        seenCount: 1,
      })
      for (const legacyId of candidate.legacyFingerprintLogIds) {
        logsToWrite.set(legacyId, {
          id: legacyId,
          siteId,
          itemId: storedItem.id,
          firstSeenAt: crawledAt,
          lastSeenAt: crawledAt,
          seenCount: 1,
        })
      }
      for (const signature of storedSignatures.filter(isExactSignature)) {
        batchExact.set(signatureLookupKey(signature), storedItem)
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
    similarGroupedCount,
    uniqueInsertedCount: insertedCount - similarGroupedCount,
    rejectedCount: parsedItems.length - normalized.length,
  }
}

export async function listItemsBySite(siteId: string, limit = 200): Promise<CrawledItem[]> {
  return db.items
    .where('[siteId+crawledAt]')
    .between([siteId, Dexie.minKey], [siteId, Dexie.maxKey])
    .reverse()
    .limit(limit)
    .toArray()
}

export async function listItemGroupsBySite(siteId: string, limit = 200): Promise<ItemGroup[]> {
  const siteItems = await listItemsBySite(siteId, limit)
  const groupIds = [...new Set(siteItems.map((item) => item.contentGroupId).filter(Boolean))] as string[]
  const crossSiteMembers = (
    await Promise.all(groupIds.map((groupId) => db.items.where('contentGroupId').equals(groupId).toArray()))
  ).flat()
  const allById = new Map([...siteItems, ...crossSiteMembers].map((item) => [item.id, item]))
  const groups = new Map<string, CrawledItem[]>()
  for (const item of allById.values()) {
    const groupId = item.contentGroupId ?? `item:${item.id}`
    const values = groups.get(groupId) ?? []
    values.push(item)
    groups.set(groupId, values)
  }
  return [...groups.entries()]
    .filter(([, values]) => values.some((item) => item.siteId === siteId))
    .map(([id, values]) => {
      const localItems = values.filter((item) => item.siteId === siteId)
      const representative = chooseRepresentative(localItems.length > 0 ? localItems : values)
      return {
        id,
        representative,
        items: [...values].sort((a, b) => b.crawledAt - a.crawledAt),
        reason: values.find((item) => item.groupReason)?.groupReason,
        score: Math.max(...values.map((item) => item.groupScore ?? 0)),
      }
    })
    .sort((a, b) => b.representative.crawledAt - a.representative.crawledAt)
}

export async function listItemCountsBySite(
  siteIds: readonly string[],
): Promise<Record<string, number>> {
  const summaries = await listItemCountSummariesBySite(siteIds)
  return Object.fromEntries(Object.entries(summaries).map(([siteId, value]) => [siteId, value.itemCount]))
}

export async function listItemCountSummariesBySite(
  siteIds: readonly string[],
): Promise<Record<string, ItemCountSummary>> {
  const entries = await Promise.all(
    siteIds.map(async (siteId) => {
      const items = await db.items.where('siteId').equals(siteId).toArray()
      const groupCount = new Set(items.map((item) => item.contentGroupId ?? `item:${item.id}`)).size
      return [siteId, { itemCount: items.length, groupCount }] as const
    }),
  )
  return Object.fromEntries(entries)
}

export async function excludeItemFromSimilarityGroup(itemId: string): Promise<void> {
  await db.transaction('rw', db.items, db.itemSignatures, async () => {
    const item = await db.items.get(itemId)
    if (!item || item.groupReason === 'global-identity') return
    await db.items.put({
      ...item,
      contentGroupId: undefined,
      groupReason: undefined,
      groupScore: undefined,
      similarityExcluded: true,
    })
    const titleSignatures = await db.itemSignatures.where('itemId').equals(itemId).toArray()
    await db.itemSignatures.bulkDelete(
      titleSignatures
        .filter((signature) => signature.kind === 'title-exact' || signature.kind === 'title-band')
        .map((signature) => signature.id),
    )
  })
}

export async function deleteCrawledItem(itemId: string): Promise<void> {
  await db.transaction('rw', db.items, db.itemSignatures, async () => {
    await db.items.delete(itemId)
    await db.itemSignatures.where('itemId').equals(itemId).delete()
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
  const prepare = (item: CrawledItem): CrawledItem => {
    const identities = normalizeItemIdentities(
      item.identities?.length ? item.identities : recoverItemIdentities(item),
    )
    return {
      ...item,
      identities,
      normalizedTitle: item.normalizedTitle ?? normalizeTitleForSimilarity(item.title),
    }
  }
  const available = allItems.slice(0, startIndex).map(prepare)
  const updatesById = new Map<string, CrawledItem>()

  for (const rawItem of batch) {
    let item = prepare(rawItem)
    const exactMatches = available.filter((candidate) => sharesExactIdentity(item, candidate))

    if (exactMatches.length > 0) {
      const oldGroupIds = new Set(
        exactMatches.map((candidate) => candidate.contentGroupId ?? `item:${candidate.id}`),
      )
      const relatedGroupMembers = available.filter((candidate) =>
        oldGroupIds.has(candidate.contentGroupId ?? `item:${candidate.id}`),
      )
      const groupId =
        oldestGroupId([...exactMatches, ...relatedGroupMembers]) ?? `item:${exactMatches[0]?.id}`
      item = {
        ...item,
        contentGroupId: groupId,
        groupReason: 'global-identity',
        groupScore: 1,
      }
      for (let index = 0; index < available.length; index += 1) {
        const candidate = available[index]
        if (!candidate) continue
        const candidateGroupId = candidate.contentGroupId ?? `item:${candidate.id}`
        if (!oldGroupIds.has(candidateGroupId) && !exactMatches.some((value) => value.id === candidate.id)) {
          continue
        }
        const grouped = {
          ...candidate,
          contentGroupId: groupId,
          groupReason: 'global-identity' as const,
          groupScore: 1,
        }
        available[index] = grouped
        updatesById.set(grouped.id, grouped)
      }
    } else {
      const itemBands = new Set(
        createItemSignatures(item)
          .filter((signature) => signature.kind === 'title-band')
          .map((signature) => signature.valueHash),
      )
      const similarityCandidates = available
        .filter((candidate) => candidate.siteId === item.siteId)
        .filter((candidate) =>
          createItemSignatures(candidate).some(
            (signature) => signature.kind === 'title-band' && itemBands.has(signature.valueHash),
          ),
        )
        .slice(-MAX_SIMILARITY_CANDIDATES)
      const matched = similarityCandidates
        .map((candidate) => ({ candidate, match: matchSimilarItems(item, candidate) }))
        .filter((entry): entry is {
          candidate: CrawledItem
          match: NonNullable<typeof entry.match>
        } => Boolean(entry.match))
        .sort((first, second) => second.match.score - first.match.score)[0]
      if (matched) {
        const groupId = matched.candidate.contentGroupId ?? `item:${matched.candidate.id}`
        item = {
          ...item,
          contentGroupId: groupId,
          groupReason: matched.match.reason,
          groupScore: matched.match.score,
        }
        if (!matched.candidate.contentGroupId) {
          const groupedCandidate = {
            ...matched.candidate,
            contentGroupId: groupId,
            groupReason: matched.match.reason,
            groupScore: matched.match.score,
          }
          const candidateIndex = available.findIndex(
            (candidate) => candidate.id === groupedCandidate.id,
          )
          if (candidateIndex >= 0) available[candidateIndex] = groupedCandidate
          updatesById.set(groupedCandidate.id, groupedCandidate)
        }
      }
    }

    available.push(item)
    updatesById.set(item.id, item)
  }

  const updates = [...updatesById.values()]
  const signatures = batch
    .map((item) => updatesById.get(item.id))
    .filter((item): item is CrawledItem => Boolean(item))
    .flatMap(createItemSignatures)
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
    if (updates.length > 0) await db.items.bulkPut(updates)
    if (signatures.length > 0) await db.itemSignatures.bulkPut(signatures)
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
