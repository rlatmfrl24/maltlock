import type { CrawledItem, ItemIdentity, ItemSignature } from '../types/contracts'
import { hashString } from '../utils/hash'

const CONTENT_CODE_REGEX = /\b([a-z]{2,10})[-_\s]?(\d{2,6})\b/gi
const TWITTER_MEDIA_REGEX =
  /\/(?:amplify_video|ext_tw_video|amplify_video_thumb|ext_tw_video_thumb)\/(\d+)(?:\/|$)/i
const TWITTER_STATUS_REGEX = /\/status\/(\d+)/i
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
    if (identity.kind !== 'preview') add(identity.kind, identity.scope, identity.value)
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
