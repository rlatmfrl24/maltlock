import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, decodeHtmlEntities, toAbsoluteUrl } from './utils'

const VIDEO_SRC_REGEX = /https?:\/\/video\.twimg\.com\/[^"'\\s<]+/i
const STATUS_URL_REGEX =
  /https?:\/\/x\.com\/(?:[^"'/]+\/status\/\d+|i\/status\/\d+)[^"'\\s<]*/i
const VIEW_COUNT_REGEXES = [
  /조회수\s*([\d,]+)/i,
  /lucide-eye[\s\S]{0,200}?<span[^>]*>\s*([\d,]+)\s*<\/span>/i,
  /<svg[^>]*[\s\S]{0,200}?<span[^>]*>\s*([\d,]+)\s*<\/span>/i,
]
const HTML_CARD_IMAGE_REGEX =
  /<img\b(?=[^>]*src=["'](https?:\/\/pbs\.twimg\.com\/[^"']+)["'])(?=[^>]*alt=["']([^"']*)["'])[^>]*>/gi
const HTML_RANK_REGEX = />(\d{1,3})(?:\s*위)?\s*<\/(?:div|span|strong|p|b)>/gi
const VIDEO_ID_REGEX = /\/(?:amplify_video|ext_tw_video)\/(\d+)\//i
const PREVIEW_IMAGE_ID_REGEX = /\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//i
const STATUS_ID_REGEX = /\/status\/(\d+)/i

interface RankedParsedItem extends ParsedItem {
  rankOrder: number
}

interface NimiApiUploader {
  handle?: string | null
}

interface NimiApiPost {
  id?: string | number | null
  uploader?: NimiApiUploader | null
}

interface NimiApiVideo {
  id?: string | number | null
  title?: string | null
  direct_url?: string | null
  thumbnail_url?: string | null
  posts?: NimiApiPost[] | null
  play_count?: number | null
  ranking?: number | null
}

interface NimiApiResponse {
  success?: boolean
  data?: NimiApiVideo[]
}

interface HtmlPreviewMatch {
  altText?: string
  index: number
  length: number
  previewImageUrl: string
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

function extractStatusId(statusUrl: string | undefined): string | undefined {
  if (!statusUrl) {
    return undefined
  }

  return statusUrl.match(STATUS_ID_REGEX)?.[1]
}

function normalizeStatusUrl(statusUrl: string | undefined): string | undefined {
  if (!statusUrl) {
    return undefined
  }

  const statusId = extractStatusId(statusUrl)
  if (statusId) {
    return `https://x.com/i/status/${statusId}`
  }

  return statusUrl.trim()
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
  statusUrl: string | undefined,
  previewImageUrl: string | undefined,
  explicitVideoId?: string,
): string {
  if (explicitVideoId) {
    return `nimi:video-id:${explicitVideoId}`
  }

  if (videoUrl !== previewImageUrl) {
    const videoIdentity = extractVideoIdentity(videoUrl)
    if (videoIdentity) {
      return `nimi:${videoIdentity}`
    }
  }

  const previewIdentity = extractPreviewIdentity(previewImageUrl)
  if (previewIdentity) {
    return `nimi:${previewIdentity}`
  }

  const statusId = extractStatusId(statusUrl)
  if (statusId) {
    return `nimi:tweet-status:${statusId}`
  }

  return `nimi:fallback:${normalizeUrlWithoutQuery(videoUrl)}`
}

function buildTitle(
  rank: number,
  rawTitle: string | undefined,
  fallbackUrl: string,
): string {
  const cleanedTitle = cleanText(rawTitle ?? '')
  if (cleanedTitle) {
    return `${rank}위 - ${cleanedTitle}`
  }

  return `${rank}위 - ${fallbackUrl}`
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

function toOptionalText(input: string | null | undefined): string | undefined {
  const cleaned = cleanText(input ?? '')
  return cleaned || undefined
}

function extractFirstStatusUrl(posts: NimiApiPost[] | null | undefined): string | undefined {
  for (const post of posts ?? []) {
    const postId = `${post.id ?? ''}`.trim()
    if (!/^\d+$/.test(postId)) {
      continue
    }

    const normalized = normalizeStatusUrl(`https://x.com/i/status/${postId}`)
    if (normalized) {
      return normalized
    }

    const handle = cleanText(post.uploader?.handle ?? '')
    if (handle) {
      return normalizeStatusUrl(`https://x.com/${handle}/status/${postId}`)
    }
  }

  return undefined
}

function toRankOrder(input: number | string | null | undefined, fallback: number): number {
  const parsedRank = Number.parseInt(`${input ?? ''}`, 10)

  if (Number.isNaN(parsedRank) || parsedRank <= 0) {
    return fallback
  }

  return parsedRank
}

function formatViewSnippet(playCount: number | null | undefined): string | undefined {
  if (typeof playCount !== 'number' || Number.isNaN(playCount) || playCount < 0) {
    return undefined
  }

  return `조회수 ${playCount}`
}

function parseApiPayload(input: string, pageUrl: string): ParsedItem[] | undefined {
  const trimmed = input.trim()

  if (!trimmed.startsWith('{')) {
    return undefined
  }

  let parsedResponse: NimiApiResponse

  try {
    parsedResponse = JSON.parse(trimmed) as NimiApiResponse
  } catch {
    return undefined
  }

  if (!Array.isArray(parsedResponse.data)) {
    return undefined
  }

  const parsedItems: RankedParsedItem[] = []
  let entryIndex = 0

  for (const video of parsedResponse.data) {
    const rawVideoUrl = `${video.direct_url ?? ''}`.trim()
    const rawPreviewImageUrl = `${video.thumbnail_url ?? ''}`.trim()

    if (!rawVideoUrl) {
      continue
    }

    entryIndex += 1

    const rankOrder = toRankOrder(video.ranking, entryIndex)
    const normalizedVideoUrl = toAbsoluteUrl(rawVideoUrl, pageUrl)
    const normalizedPreviewImageUrl = rawPreviewImageUrl
      ? toAbsoluteUrl(rawPreviewImageUrl, pageUrl)
      : undefined
    const normalizedStatusUrl = extractFirstStatusUrl(video.posts)
    const explicitVideoId = `${video.id ?? ''}`.trim() || undefined

    parsedItems.push({
      title: buildTitle(
        rankOrder,
        toOptionalText(video.title),
        normalizedStatusUrl ?? normalizedVideoUrl,
      ),
      url: normalizedVideoUrl,
      dedupeKey: buildDedupeKey(
        normalizedVideoUrl,
        normalizedStatusUrl,
        normalizedPreviewImageUrl,
        explicitVideoId,
      ),
      previewImageUrl: normalizedPreviewImageUrl,
      summary: normalizedStatusUrl,
      rawHtmlSnippet: formatViewSnippet(video.play_count),
      rankOrder,
    })
  }

  return dedupeRankedItems(parsedItems)
}

function collectHtmlPreviewMatches(html: string): HtmlPreviewMatch[] {
  const matches: HtmlPreviewMatch[] = []

  for (const match of html.matchAll(HTML_CARD_IMAGE_REGEX)) {
    const previewImageUrl = match[1]?.trim()
    if (!previewImageUrl || match.index === undefined) {
      continue
    }

    matches.push({
      previewImageUrl,
      altText: toOptionalText(decodeHtmlEntities(match[2] ?? '')),
      index: match.index,
      length: match[0]?.length ?? 0,
    })
  }

  return matches
}

function extractHtmlRank(beforeImageHtml: string, fallback: number): number {
  let lastMatch = fallback

  for (const match of beforeImageHtml.matchAll(HTML_RANK_REGEX)) {
    const parsedRank = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isNaN(parsedRank) && parsedRank > 0) {
      lastMatch = parsedRank
    }
  }

  return lastMatch
}

function extractHtmlViewSnippet(html: string): string | undefined {
  for (const regex of VIEW_COUNT_REGEXES) {
    const rawCount = regex.exec(html)?.[1]
    if (!rawCount) {
      continue
    }

    return `조회수 ${rawCount.replace(/,/g, '')}`
  }

  return undefined
}

function parseHtmlFallback(input: string, pageUrl: string): ParsedItem[] {
  const previewMatches = collectHtmlPreviewMatches(input)
  const parsedItems: RankedParsedItem[] = []

  for (let index = 0; index < previewMatches.length; index += 1) {
    const current = previewMatches[index]
    if (!current) {
      continue
    }

    const previous = previewMatches[index - 1]
    const next = previewMatches[index + 1]
    const chunkStart = previous ? previous.index + previous.length : 0
    const chunkEnd = next ? next.index : input.length
    const chunk = input.slice(chunkStart, chunkEnd)
    const relativeImageIndex = Math.max(0, current.index - chunkStart)
    const beforeImageHtml = chunk.slice(0, relativeImageIndex)
    const afterImageHtml = chunk.slice(relativeImageIndex)
    const rankOrder = extractHtmlRank(beforeImageHtml, index + 1)
    const absolutePreviewImageUrl = toAbsoluteUrl(
      decodeHtmlEntities(current.previewImageUrl),
      pageUrl,
    )
    const rawVideoUrl =
      VIDEO_SRC_REGEX.exec(afterImageHtml)?.[0] ??
      VIDEO_SRC_REGEX.exec(beforeImageHtml)?.[0]
    const normalizedVideoUrl = rawVideoUrl
      ? toAbsoluteUrl(decodeHtmlEntities(rawVideoUrl), pageUrl)
      : absolutePreviewImageUrl
    const rawStatusUrl =
      STATUS_URL_REGEX.exec(beforeImageHtml)?.[0] ??
      STATUS_URL_REGEX.exec(afterImageHtml)?.[0]
    const normalizedStatusUrl = normalizeStatusUrl(rawStatusUrl)

    parsedItems.push({
      title: buildTitle(
        rankOrder,
        current.altText,
        normalizedStatusUrl ?? absolutePreviewImageUrl,
      ),
      url: normalizedVideoUrl,
      dedupeKey: buildDedupeKey(
        normalizedVideoUrl,
        normalizedStatusUrl,
        absolutePreviewImageUrl,
      ),
      previewImageUrl: absolutePreviewImageUrl,
      summary: normalizedStatusUrl,
      rawHtmlSnippet: extractHtmlViewSnippet(afterImageHtml),
      rankOrder,
    })
  }

  return dedupeRankedItems(parsedItems)
}

export const nimiTwRankingParser: SiteParser = (input: string, pageUrl: string) => {
  return parseApiPayload(input, pageUrl) ?? parseHtmlFallback(input, pageUrl)
}
