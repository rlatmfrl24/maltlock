import type {
  CrawledItem,
  ItemIdentity,
  ItemIdentityKind,
  ItemSignature,
} from '../types/contracts'
import { hashString } from '../utils/hash'

const RANK_PREFIX_REGEX = /^\s*(?:#?\d+\s*(?:위|등|rank)?|rank\s*#?\d+)\s*[-.:)]*\s*/i
const FILE_SIZE_REGEX = /\b\d+(?:\.\d+)?\s*(?:kb|mb|gb|tb)\b/gi
const BRACKET_TAG_REGEX = /[([<{][^\])}>]{1,40}[\])}>]/g
const CONTENT_CODE_REGEX = /\b([a-z]{2,10})[-_\s]?(\d{2,6})\b/gi
const TWITTER_MEDIA_REGEX =
  /\/(?:amplify_video|ext_tw_video|amplify_video_thumb|ext_tw_video_thumb)\/(\d+)(?:\/|$)/i
const TWITTER_STATUS_REGEX = /\/status\/(\d+)/i
const PLACEHOLDER_REGEX = /(?:placeholder|no[-_ ]?image|default[-_ ]?(?:thumb|image)|blank\.(?:png|jpe?g|webp))/i
const VALID_TOKEN_REGEX = /[\p{L}\p{N}]{2,}/gu
const MIN_TITLE_LENGTH = 12
const MINHASH_SEEDS = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35]

function normalizeIdentityValue(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

export function normalizeItemIdentities(
  identities: readonly ItemIdentity[] | undefined,
): ItemIdentity[] {
  const unique = new Map<string, ItemIdentity>()

  for (const identity of identities ?? []) {
    const value = normalizeIdentityValue(identity.value)
    if (!value) continue
    const key = `${identity.scope}:${identity.kind}:${value}`
    unique.set(key, { ...identity, value })
  }

  return [...unique.values()]
}

export function extractContentCodes(input: string): string[] {
  const codes = new Set<string>()
  for (const match of input.normalize('NFKC').matchAll(CONTENT_CODE_REGEX)) {
    const prefix = match[1]?.toLowerCase()
    const number = match[2]
    if (prefix && number && prefix !== 'rank') codes.add(`${prefix}-${number}`)
  }
  return [...codes]
}

export function normalizeTitleForSimilarity(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(RANK_PREFIX_REGEX, '')
    .replace(FILE_SIZE_REGEX, ' ')
    .replace(BRACKET_TAG_REGEX, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createCharacterTrigrams(input: string): Set<string> {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (compact.length < 3) return new Set()
  const grams = new Set<string>()
  for (let index = 0; index <= compact.length - 3; index += 1) {
    grams.add(compact.slice(index, index + 3))
  }
  return grams
}

export function calculateDiceScore(first: string, second: string): number {
  const firstGrams = createCharacterTrigrams(first)
  const secondGrams = createCharacterTrigrams(second)
  if (firstGrams.size === 0 || secondGrams.size === 0) return 0
  let intersection = 0
  for (const gram of firstGrams) if (secondGrams.has(gram)) intersection += 1
  return (2 * intersection) / (firstGrams.size + secondGrams.size)
}

function commonTokenCount(first: string, second: string): number {
  const firstTokens = new Set(first.match(VALID_TOKEN_REGEX) ?? [])
  const secondTokens = new Set(second.match(VALID_TOKEN_REGEX) ?? [])
  let count = 0
  for (const token of firstTokens) if (secondTokens.has(token)) count += 1
  return count
}

function hashWithSeed(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

export function createTitleBands(normalizedTitle: string): string[] {
  const grams = createCharacterTrigrams(normalizedTitle)
  if (normalizedTitle.length < MIN_TITLE_LENGTH || grams.size === 0) return []

  return MINHASH_SEEDS.map((seed, band) => {
    let minimum = 0xffffffff
    for (const gram of grams) minimum = Math.min(minimum, hashWithSeed(gram, seed))
    return `${band}:${minimum.toString(16)}`
  })
}

function explicitValues(item: Pick<CrawledItem, 'identities'>): Map<ItemIdentityKind, Set<string>> {
  const result = new Map<ItemIdentityKind, Set<string>>()
  for (const identity of normalizeItemIdentities(item.identities)) {
    if (identity.kind !== 'media-id' && identity.kind !== 'content-code') continue
    const values = result.get(identity.kind) ?? new Set<string>()
    values.add(identity.value)
    result.set(identity.kind, values)
  }
  return result
}

export function hasConflictingExplicitIdentity(
  first: Pick<CrawledItem, 'identities'>,
  second: Pick<CrawledItem, 'identities'>,
): boolean {
  const firstValues = explicitValues(first)
  const secondValues = explicitValues(second)
  for (const kind of ['media-id', 'content-code'] as const) {
    const left = firstValues.get(kind)
    const right = secondValues.get(kind)
    if (!left?.size || !right?.size) continue
    if (![...left].some((value) => right.has(value))) return true
  }
  return false
}

export function sharesExactIdentity(first: CrawledItem, second: CrawledItem): boolean {
  const secondIdentities = normalizeItemIdentities(second.identities)
  return normalizeItemIdentities(first.identities).some((identity) => {
    if (identity.kind === 'preview') return false
    if (identity.scope === 'site' && first.siteId !== second.siteId) return false
    return secondIdentities.some(
      (candidate) =>
        candidate.kind === identity.kind &&
        candidate.scope === identity.scope &&
        candidate.value === identity.value,
    )
  })
}

function previewSignature(item: Pick<CrawledItem, 'previewImageUrl' | 'identities'>): string | undefined {
  const explicit = normalizeItemIdentities(item.identities).find(
    (identity) => identity.kind === 'preview',
  )?.value
  if (explicit) return explicit
  if (!item.previewImageUrl || PLACEHOLDER_REGEX.test(item.previewImageUrl)) return undefined
  try {
    const url = new URL(item.previewImageUrl)
    return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase()}`
  } catch {
    return undefined
  }
}

export interface SimilarityMatch {
  reason: 'title-exact' | 'title-similar'
  score: number
}

export function matchSimilarItems(
  first: CrawledItem,
  second: CrawledItem,
): SimilarityMatch | undefined {
  if (first.siteId !== second.siteId) return undefined
  if (first.similarityExcluded || second.similarityExcluded) return undefined
  if (isPlaceholderPreview(first.previewImageUrl) || isPlaceholderPreview(second.previewImageUrl)) {
    return undefined
  }
  if (hasConflictingExplicitIdentity(first, second)) return undefined

  const firstTitle = first.normalizedTitle ?? normalizeTitleForSimilarity(first.title)
  const secondTitle = second.normalizedTitle ?? normalizeTitleForSimilarity(second.title)
  if (firstTitle.length < MIN_TITLE_LENGTH || secondTitle.length < MIN_TITLE_LENGTH) return undefined
  if (firstTitle === secondTitle) return { reason: 'title-exact', score: 1 }

  const score = calculateDiceScore(firstTitle, secondTitle)
  const samePreview = previewSignature(first) === previewSignature(second) && Boolean(previewSignature(first))
  const threshold = samePreview ? 0.85 : 0.92
  if (score < threshold || commonTokenCount(firstTitle, secondTitle) < 2) return undefined
  return { reason: 'title-similar', score }
}

export function createItemSignatures(item: CrawledItem): ItemSignature[] {
  const signatures: ItemSignature[] = []
  const add = (
    kind: ItemSignature['kind'],
    scope: ItemSignature['scope'],
    value: string,
  ) => {
    const valueHash = hashString(normalizeIdentityValue(value))
    signatures.push({
      id: `${item.id}:${scope}:${kind}:${valueHash}`,
      itemId: item.id,
      siteId: item.siteId,
      kind,
      scope,
      valueHash,
      createdAt: item.crawledAt,
    })
  }

  for (const identity of normalizeItemIdentities(item.identities)) {
    add(identity.kind, identity.scope, identity.value)
  }
  const normalizedTitle = item.normalizedTitle ?? normalizeTitleForSimilarity(item.title)
  if (!item.similarityExcluded && normalizedTitle.length >= MIN_TITLE_LENGTH) {
    add('title-exact', 'site', normalizedTitle)
    for (const band of createTitleBands(normalizedTitle)) add('title-band', 'site', band)
  }
  return signatures
}

export function recoverItemIdentities(
  item: Pick<CrawledItem, 'url' | 'previewImageUrl' | 'summary' | 'title'>,
): ItemIdentity[] {
  const identities: ItemIdentity[] = []
  const sources = [item.url, item.previewImageUrl, item.summary].filter(
    (value): value is string => Boolean(value),
  )
  for (const source of sources) {
    const mediaId = source.match(TWITTER_MEDIA_REGEX)?.[1]
    if (mediaId) identities.push({ kind: 'media-id', value: mediaId, scope: 'global' })
    const statusId = source.match(TWITTER_STATUS_REGEX)?.[1]
    if (statusId) identities.push({ kind: 'media-id', value: statusId, scope: 'global' })
  }
  let pathname = ''
  try {
    pathname = new URL(item.url).pathname
  } catch {
    // Invalid legacy URLs have no path-based content code.
  }
  for (const code of extractContentCodes(`${item.title} ${pathname}`)) {
    identities.push({ kind: 'content-code', value: code, scope: 'global' })
  }
  try {
    const parsed = new URL(item.url)
    const canonical = `${parsed.pathname.toLowerCase()}${parsed.search}`
    if (parsed.pathname !== '/') identities.push({ kind: 'canonical-url', value: canonical, scope: 'site' })
  } catch {
    // Invalid legacy URLs are ignored during recovery.
  }
  return normalizeItemIdentities(identities)
}

export function isPlaceholderPreview(url: string | undefined): boolean {
  return Boolean(url && PLACEHOLDER_REGEX.test(url))
}
