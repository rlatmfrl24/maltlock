import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, decodeHtmlEntities, toAbsoluteUrl } from './utils'
import { twitterMediaIdentities } from './identities'
import { getNimiPlatform, isNimiPlatform } from '../extension/nimi'
import type { NimiPlatform } from '../types/contracts'

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
  id?: string | number | null
  url?: string | null
  handle?: string | null
  display_name?: string | null
  name?: string | null
}

interface NimiApiPost {
  id?: string | number | null
  url?: string | null
  author?: NimiApiUploader | null
  uploader?: NimiApiUploader | null
}

interface NimiApiVideo {
  platform?: string | null
  video_id?: string | number | null
  id?: string | number | null
  title?: string | null
  file_url?: string | null
  direct_url?: string | null
  hls_url?: string | null
  thumbnail_url?: string | null
  posts?: NimiApiPost[] | null
  play_count?: number | null
  ranking?: number | null
}

interface NimiApiResponse {
  success?: boolean
  error?: unknown
  items?: NimiApiVideo[]
  data?: NimiApiVideo[]
}

type NimiApiPayload = NimiApiResponse | NimiApiVideo[]

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

  try {
    const parsed = new URL(decodeHtmlEntities(statusUrl.trim()))
    const hostname = parsed.hostname.toLowerCase()
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (hostname !== 'x.com' &&
        hostname !== 'www.x.com' &&
        hostname !== 'twitter.com' &&
        hostname !== 'www.twitter.com')
    ) {
      return undefined
    }

    const statusMatch = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/i)
    if (!statusMatch?.[1] || !statusMatch[2]) {
      return undefined
    }

    return `https://x.com/${statusMatch[1]}/status/${statusMatch[2]}`
  } catch {
    return undefined
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
      identities: item.identities,
      previewImageUrl: item.previewImageUrl,
      summary: item.summary,
      price: item.price,
      rawHtmlSnippet: item.rawHtmlSnippet,
      sourcePlatform: item.sourcePlatform,
    }))
}

function toOptionalText(input: string | null | undefined): string | undefined {
  const cleaned = cleanText(input ?? '')
  return cleaned || undefined
}

function extractFirstStatusUrl(posts: NimiApiPost[] | null | undefined): string | undefined {
  for (const post of posts ?? []) {
    const explicitStatusUrl = normalizeStatusUrl(post.url ?? undefined)
    if (explicitStatusUrl) {
      return explicitStatusUrl
    }

    const postId = `${post.id ?? ''}`.trim()
    if (!/^\d+$/.test(postId)) {
      continue
    }

    const account = post.author ?? post.uploader
    const handle = cleanText(account?.handle ?? '').replace(/^@/, '')
    if (handle) {
      return normalizeStatusUrl(`https://x.com/${handle}/status/${postId}`)
    }

    const normalized = normalizeStatusUrl(`https://x.com/i/status/${postId}`)
    if (normalized) {
      return normalized
    }
  }

  return undefined
}

function extractFirstPostUrl(posts: NimiApiPost[] | null | undefined, platform: NimiPlatform): string | undefined {
  if (platform === 'tw') return extractFirstStatusUrl(posts)
  for (const post of posts ?? []) {
    if (!post.url) continue
    try {
      const url = new URL(post.url)
      if (url.protocol !== 'https:' || url.port || url.username || url.password) continue
      const host = url.hostname.replace(/^www\./, '')
      const valid = platform === 'ig' ? host === 'instagram.com' && /^\/(?:p|reel|tv)\/[^/]+\/?$/.test(url.pathname)
        : platform === 'tt' ? host === 'tiktok.com' && /^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)
          : host === 'bsky.app' && /^\/profile\/[^/]+\/post\/[^/]+\/?$/.test(url.pathname)
      if (!valid) continue
      url.search = ''
      url.hash = ''
      return url.href
    } catch { /* Ignore malformed original links, never invent a tweet URL. */ }
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

function extractApiVideos(payload: NimiApiPayload): NimiApiVideo[] | undefined {
  if (Array.isArray(payload)) {
    return payload
  }

  if (!payload || typeof payload !== 'object' || payload.success === false || payload.error) return undefined

  if (Array.isArray(payload.items)) {
    return payload.items
  }

  if (Array.isArray(payload.data)) {
    return payload.data
  }

  return undefined
}

export function isEmptyNimiApiPayload(input: string): boolean {
  try {
    const payload = JSON.parse(input) as NimiApiPayload
    return extractApiVideos(payload)?.length === 0
  } catch { return false }
}

function deriveApiTitle(video: NimiApiVideo): string | undefined {
  const explicitTitle = toOptionalText(video.title)
  if (explicitTitle) {
    return explicitTitle
  }

  const firstPost = video.posts?.[0]
  const account = firstPost?.author ?? firstPost?.uploader
  const displayName = toOptionalText(
    account?.display_name ?? account?.name,
  )
  if (displayName) {
    return `${displayName}님의 동영상`
  }

  const handle = toOptionalText(account?.handle)
  if (handle) {
    return `${handle}님의 동영상`
  }

  return undefined
}

function parseApiPayload(input: string, pageUrl: string): ParsedItem[] | undefined {
  const trimmed = input.trim()

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined
  }

  let parsedPayload: NimiApiPayload

  try {
    parsedPayload = JSON.parse(trimmed) as NimiApiPayload
  } catch {
    return undefined
  }

  const videos = extractApiVideos(parsedPayload)

  if (!Array.isArray(videos)) {
    throw new Error('NimiWiki API 목록 응답 형식이 올바르지 않습니다.')
  }

  const platform = getNimiPlatform(pageUrl)
  if (!platform) throw new Error('NimiWiki 플랫폼을 확인하지 못했습니다.')

  const parsedItems: RankedParsedItem[] = []
  let entryIndex = 0

  for (const video of videos) {
    if (!video || (video.platform != null && (!isNimiPlatform(video.platform) || video.platform !== platform))) {
      throw new Error('NimiWiki API의 플랫폼이 수집한 목록과 다릅니다.')
    }
    const rawVideoUrl = [video.file_url, video.direct_url, video.hls_url]
      .map((value) => `${value ?? ''}`.trim())
      .find(Boolean)
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
    const normalizedStatusUrl = extractFirstPostUrl(video.posts, platform)
    const explicitVideoId =
      `${(platform === 'tw' ? video.video_id ?? video.id : video.id) ?? ''}`.trim() || undefined
    if (platform !== 'tw' && !explicitVideoId) throw new Error('NimiWiki 항목 ID를 확인하지 못했습니다.')

    parsedItems.push({
      title: buildTitle(
        rankOrder,
        deriveApiTitle(video),
        normalizedStatusUrl ?? normalizedVideoUrl,
      ),
      url: normalizedVideoUrl,
      sourcePlatform: platform,
      dedupeKey: platform !== 'tw' ? `nimi:${platform}:item:${explicitVideoId}` : buildDedupeKey(
        normalizedVideoUrl,
        normalizedStatusUrl,
        normalizedPreviewImageUrl,
        explicitVideoId,
      ),
      identities: platform !== 'tw' ? [{ kind: 'source-id', scope: 'site', value: `nimi:${platform}:item:${explicitVideoId}` }] : twitterMediaIdentities(
        normalizedVideoUrl,
        normalizedStatusUrl,
        normalizedPreviewImageUrl,
        explicitVideoId
          ? `https://video.twimg.com/amplify_video/${explicitVideoId}/`
          : undefined,
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
  if (getNimiPlatform(pageUrl) !== 'tw') return []
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

    if (!rawVideoUrl) {
      continue
    }

    const normalizedVideoUrl = toAbsoluteUrl(decodeHtmlEntities(rawVideoUrl), pageUrl)
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
      identities: twitterMediaIdentities(
        normalizedVideoUrl,
        normalizedStatusUrl,
        absolutePreviewImageUrl,
      ),
      previewImageUrl: absolutePreviewImageUrl,
      summary: normalizedStatusUrl,
      rawHtmlSnippet: extractHtmlViewSnippet(afterImageHtml),
      sourcePlatform: 'tw',
      rankOrder,
    })
  }

  return dedupeRankedItems(parsedItems)
}

export const nimiTwRankingParser: SiteParser = (input: string, pageUrl: string) => {
  return parseApiPayload(input, pageUrl) ?? parseHtmlFallback(input, pageUrl)
}
