import type { ParsedItem, SiteParser } from '../types/contracts'
import { decodeHtmlEntities, toAbsoluteUrl } from './utils'
import { twitterMediaIdentities } from './identities'

const VIDEO_URL_ANCHOR_REGEX =
  /<a\s+[^>]*href=["'](https?:\/\/video\.twimg\.com\/[^"']+)["'][^>]*>\s*(?:동영상\s*URL|동영상URL|動画\s*URL|動画URL|Video\s*URL|VideoURL)\s*<\/a\s*>/gi
const RANK_MARKER_REGEX = /<img\s+[^>]*src=["'][^"']*rank\d+\.png["'][^>]*>\s*(\d+)\s*위/gi
const X_LINK_REGEX = /href=["'](https?:\/\/x\.com\/[^"']+)["']/gi
const PREVIEW_IMAGE_REGEX =
  /<img\s+[^>]*src=["'](https?:\/\/pbs\.twimg\.com\/[^"']+)["'][^>]*>/gi
const VIDEO_ID_REGEX = /\/(?:amplify_video|ext_tw_video)\/(\d+)\//i
const PREVIEW_IMAGE_ID_REGEX = /\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//i
const TWEET_STATUS_ID_REGEX = /\/status\/(\d+)/i
const HTML_TAG_REGEX = /<(?:div|article)\b[^>]*>/gi
const HTML_ATTRIBUTE_REGEX = /([^\s=/>]+)\s*=\s*(["'])([\s\S]*?)\2/g

interface RankMarker {
  index: number
  rank: number
}

interface RankItemTag {
  index: number
  attributes: Map<string, string>
}

interface RankedParsedItem extends ParsedItem {
  rankOrder: number
}

function findFirstMatch(regex: RegExp, source: string): string | undefined {
  for (const match of source.matchAll(regex)) {
    if (match[1]) {
      return match[1]
    }
  }

  return undefined
}

function extractRankMarkers(source: string): RankMarker[] {
  const markers: RankMarker[] = []

  for (const match of source.matchAll(RANK_MARKER_REGEX)) {
    if (match.index === undefined) {
      continue
    }

    const parsedRank = Number.parseInt(match[1] ?? '', 10)
    if (Number.isNaN(parsedRank)) {
      continue
    }

    markers.push({
      index: match.index,
      rank: parsedRank,
    })
  }

  return markers
}

function parseHtmlAttributes(tagHtml: string): Map<string, string> {
  const attributes = new Map<string, string>()

  for (const match of tagHtml.matchAll(HTML_ATTRIBUTE_REGEX)) {
    const name = match[1]?.toLowerCase()
    const value = match[3]
    if (name && value !== undefined) {
      attributes.set(name, decodeHtmlEntities(value))
    }
  }

  return attributes
}

function extractRankItemTags(source: string): RankItemTag[] {
  const tags: RankItemTag[] = []

  for (const match of source.matchAll(HTML_TAG_REGEX)) {
    if (match.index === undefined) {
      continue
    }

    const attributes = parseHtmlAttributes(match[0])
    const classNames = attributes.get('class')?.split(/\s+/) ?? []
    if (!classNames.includes('rank-item')) {
      continue
    }

    tags.push({
      index: match.index,
      attributes,
    })
  }

  return tags
}

function buildTitle(rank: string, tweetUrl: string | undefined, videoUrl: string): string {
  if (tweetUrl) {
    return `${rank}위 - ${tweetUrl}`
  }

  return `${rank}위 - ${videoUrl}`
}

function extractStatusId(tweetUrl: string | undefined): string | undefined {
  if (!tweetUrl) {
    return undefined
  }

  const match = tweetUrl.match(TWEET_STATUS_ID_REGEX)
  return match?.[1]
}

function normalizeTweetUrl(tweetUrl: string | undefined): string | undefined {
  const statusId = extractStatusId(tweetUrl)
  if (!statusId) {
    return tweetUrl?.trim()
  }

  return `https://x.com/i/status/${statusId}`
}

function isHttpUrlForHost(input: string, hostname: string): boolean {
  try {
    const parsed = new URL(input)
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname.toLowerCase() === hostname
    )
  } catch {
    return false
  }
}

function isTweetUrl(input: string): boolean {
  try {
    const parsed = new URL(input)
    const hostname = parsed.hostname.toLowerCase()
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      (hostname === 'x.com' ||
        hostname === 'www.x.com' ||
        hostname === 'twitter.com' ||
        hostname === 'www.twitter.com')
    )
  } catch {
    return false
  }
}

function normalizeUrlWithoutQuery(input: string): string {
  try {
    const parsed = new URL(input)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().toLowerCase()
  } catch {
    return input.trim().replace(/[?#].*$/, '').toLowerCase()
  }
}

function extractVideoIdentity(videoUrl: string): string {
  const matchedVideoId = videoUrl.match(VIDEO_ID_REGEX)?.[1]
  if (matchedVideoId) {
    return `video-id:${matchedVideoId}`
  }

  return `video-url:${normalizeUrlWithoutQuery(videoUrl)}`
}

function extractPreviewIdentity(previewImageUrl: string | undefined): string | undefined {
  if (!previewImageUrl) {
    return undefined
  }

  const matchedPreviewId = previewImageUrl.match(PREVIEW_IMAGE_ID_REGEX)?.[1]
  if (matchedPreviewId) {
    return `preview-id:${matchedPreviewId}`
  }

  return `preview-url:${normalizeUrlWithoutQuery(previewImageUrl)}`
}

function buildDedupeKey(
  videoUrl: string,
  tweetUrl: string | undefined,
  previewImageUrl: string | undefined,
): string {
  const videoIdentity = extractVideoIdentity(videoUrl)
  if (videoIdentity) {
    return `twidouga:${videoIdentity}`
  }

  const tweetStatusId = extractStatusId(tweetUrl)
  if (tweetStatusId) {
    return `twidouga:tweet-status:${tweetStatusId}`
  }

  const previewIdentity = extractPreviewIdentity(previewImageUrl)
  if (previewIdentity) {
    return `twidouga:${previewIdentity}`
  }

  return `twidouga:fallback:${normalizeUrlWithoutQuery(videoUrl)}`
}

function dedupeRankedItems(items: RankedParsedItem[]): ParsedItem[] {
  const byKey = new Map<string, RankedParsedItem>()

  for (const item of items) {
    const key = item.dedupeKey ?? `${item.url.toLowerCase()}|${item.title.toLowerCase()}`
    const existing = byKey.get(key)

    if (!existing || item.rankOrder < existing.rankOrder) {
      byKey.set(key, item)
    }
  }

  return [...byKey.values()]
    .sort((a, b) => a.rankOrder - b.rankOrder)
    .map((item) => ({
      title: item.title,
      url: item.url,
      dedupeKey: item.dedupeKey,
      identities: item.identities,
      previewImageUrl: item.previewImageUrl,
      summary: item.summary,
      price: item.price,
      rawHtmlSnippet: item.rawHtmlSnippet,
    }))
}

function parseRankItemDataAttributes(
  html: string,
  pageUrl: string,
): RankedParsedItem[] {
  const rankItemTags = extractRankItemTags(html)
  const parsed: RankedParsedItem[] = []

  for (let index = 0; index < rankItemTags.length; index += 1) {
    const rankItem = rankItemTags[index]
    const rawVideoUrl = rankItem.attributes.get('data-video')?.trim()
    if (!rawVideoUrl) {
      continue
    }

    const videoUrl = toAbsoluteUrl(rawVideoUrl, pageUrl)
    if (!isHttpUrlForHost(videoUrl, 'video.twimg.com')) {
      continue
    }

    const rawPreviewImageUrl = rankItem.attributes.get('data-image')?.trim()
    const resolvedPreviewImageUrl = rawPreviewImageUrl
      ? toAbsoluteUrl(rawPreviewImageUrl, pageUrl)
      : undefined
    const previewImageUrl =
      resolvedPreviewImageUrl &&
      isHttpUrlForHost(resolvedPreviewImageUrl, 'pbs.twimg.com')
        ? resolvedPreviewImageUrl
        : undefined

    const rawTweetUrl = rankItem.attributes.get('data-url')?.trim()
    const resolvedTweetUrl = rawTweetUrl
      ? toAbsoluteUrl(rawTweetUrl, pageUrl)
      : undefined
    const tweetUrl =
      resolvedTweetUrl && isTweetUrl(resolvedTweetUrl)
        ? normalizeTweetUrl(resolvedTweetUrl)
        : undefined

    const nextRankItem = rankItemTags[index + 1]
    const context = html.slice(
      rankItem.index,
      nextRankItem?.index ?? html.length,
    )
    const rank =
      context.match(/(\d+)\s*위/i)?.[1] ?? `${parsed.length + 1}`
    const rankOrder = Number.parseInt(rank, 10) || parsed.length + 1

    parsed.push({
      title: buildTitle(rank, tweetUrl, videoUrl),
      url: videoUrl,
      dedupeKey: buildDedupeKey(videoUrl, tweetUrl, previewImageUrl),
      identities: twitterMediaIdentities(videoUrl, tweetUrl, previewImageUrl),
      previewImageUrl,
      summary: tweetUrl,
      rankOrder,
    })
  }

  return parsed
}

export const twidougaRankingT1Parser: SiteParser = (html: string, pageUrl: string) => {
  const normalizedHtml = html.replace(/\r\n/g, '\n')
  const dataAttributeItems = parseRankItemDataAttributes(normalizedHtml, pageUrl)
  if (dataAttributeItems.length > 0) {
    return dedupeRankedItems(dataAttributeItems)
  }

  const rankMarkers = extractRankMarkers(normalizedHtml)
  const parsed: RankedParsedItem[] = []

  let entryIndex = 0
  let rankCursor = 0
  for (const match of normalizedHtml.matchAll(VIDEO_URL_ANCHOR_REGEX)) {
    if (match.index === undefined) {
      continue
    }

    entryIndex += 1

    const videoUrl = match[1]?.trim()
    if (!videoUrl) {
      continue
    }

    while (
      rankCursor + 1 < rankMarkers.length &&
      rankMarkers[rankCursor + 1].index <= match.index
    ) {
      rankCursor += 1
    }

    const currentRankMarker = rankMarkers[rankCursor]
    const nextRankMarker = rankMarkers[rankCursor + 1]
    const contextStart = currentRankMarker?.index ?? 0
    const contextEnd = nextRankMarker?.index ?? normalizedHtml.length
    const context = normalizedHtml.slice(contextStart, contextEnd)

    const rank = currentRankMarker ? `${currentRankMarker.rank}` : `${entryIndex}`
    const tweetUrl = normalizeTweetUrl(findFirstMatch(X_LINK_REGEX, context)?.trim())
    const previewImageUrl = findFirstMatch(PREVIEW_IMAGE_REGEX, context)?.trim()
    const absoluteVideoUrl = toAbsoluteUrl(videoUrl, pageUrl)
    const absolutePreviewImageUrl = previewImageUrl
      ? toAbsoluteUrl(previewImageUrl, pageUrl)
      : undefined

    parsed.push({
      title: buildTitle(rank, tweetUrl, absoluteVideoUrl),
      url: absoluteVideoUrl,
      dedupeKey: buildDedupeKey(absoluteVideoUrl, tweetUrl, absolutePreviewImageUrl),
      identities: twitterMediaIdentities(
        absoluteVideoUrl,
        tweetUrl,
        absolutePreviewImageUrl,
      ),
      previewImageUrl: absolutePreviewImageUrl,
      summary: tweetUrl,
      rankOrder: Number.parseInt(rank, 10) || entryIndex,
    })
  }

  return dedupeRankedItems(parsed)
}
