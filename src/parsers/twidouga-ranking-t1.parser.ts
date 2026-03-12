import type { ParsedItem, SiteParser } from '../types/contracts'
import { toAbsoluteUrl } from './utils'

const VIDEO_URL_ANCHOR_REGEX =
  /<a\s+[^>]*href=["'](https?:\/\/video\.twimg\.com\/[^"']+)["'][^>]*>\s*(?:동영상\s*URL|동영상URL|動画\s*URL|動画URL|Video\s*URL|VideoURL)\s*<\/a\s*>/gi
const RANK_MARKER_REGEX = /<img\s+[^>]*src=["'][^"']*rank\d+\.png["'][^>]*>\s*(\d+)\s*위/gi
const X_LINK_REGEX = /href=["'](https?:\/\/x\.com\/[^"']+)["']/gi
const PREVIEW_IMAGE_REGEX =
  /<img\s+[^>]*src=["'](https?:\/\/pbs\.twimg\.com\/[^"']+)["'][^>]*>/gi
const VIDEO_ID_REGEX = /\/(?:amplify_video|ext_tw_video)\/(\d+)\//i
const PREVIEW_IMAGE_ID_REGEX = /\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//i
const TWEET_STATUS_ID_REGEX = /\/status\/(\d+)/i

interface RankMarker {
  index: number
  rank: number
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
      previewImageUrl: item.previewImageUrl,
      summary: item.summary,
      price: item.price,
      rawHtmlSnippet: item.rawHtmlSnippet,
    }))
}

export const twidougaRankingT1Parser: SiteParser = (html: string, pageUrl: string) => {
  const normalizedHtml = html.replace(/\r\n/g, '\n')
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
      previewImageUrl: absolutePreviewImageUrl,
      summary: tweetUrl,
      rankOrder: Number.parseInt(rank, 10) || entryIndex,
    })
  }

  return dedupeRankedItems(parsed)
}
