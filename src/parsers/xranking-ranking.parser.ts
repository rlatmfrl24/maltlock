import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, decodeHtmlEntities, toAbsoluteUrl } from './utils'

const ARTICLE_REGEX = /<article\b[\s\S]*?<\/article>/gi
const RANK_REGEX =
  /<div[^>]*class=["'][^"']*absolute\s+top-3\s+left-3[^"']*["'][^>]*>\s*(\d+)\s*<\/div>/i
const VIDEO_SRC_REGEX = /<video\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i
const VIDEO_POSTER_REGEX = /<video\b[^>]*\bposter=["']([^"']+)["'][^>]*>/i
const STATUS_LINK_REGEX =
  /<a[^>]*href=["'](https?:\/\/x\.com\/(?:[^"'/]+\/status\/\d+|i\/status\/\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
const VIEW_COUNT_REGEX = /lucide-eye[\s\S]*?<span>\s*(\d+)\s*<\/span>/i
const VIDEO_ID_REGEX = /\/(?:amplify_video|ext_tw_video)\/(\d+)\//i
const PREVIEW_IMAGE_ID_REGEX = /\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//i
const STATUS_ID_REGEX = /\/status\/(\d+)/i

interface RankedParsedItem extends ParsedItem {
  rankOrder: number
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
): string {
  const videoIdentity = extractVideoIdentity(videoUrl)
  if (videoIdentity) {
    return `xranking:${videoIdentity}`
  }

  const statusId = extractStatusId(statusUrl)
  if (statusId) {
    return `xranking:tweet-status:${statusId}`
  }

  const previewIdentity = extractPreviewIdentity(previewImageUrl)
  if (previewIdentity) {
    return `xranking:${previewIdentity}`
  }

  return `xranking:fallback:${normalizeUrlWithoutQuery(videoUrl)}`
}

function buildTitle(
  rank: number,
  cardTitle: string | undefined,
  statusUrl: string | undefined,
  videoUrl: string,
): string {
  if (cardTitle) {
    return `${rank}위 - ${cardTitle}`
  }

  if (statusUrl) {
    return `${rank}위 - ${statusUrl}`
  }

  return `${rank}위 - ${videoUrl}`
}

function extractRankOrder(articleHtml: string, fallback: number): number {
  const matchedRank = RANK_REGEX.exec(articleHtml)?.[1]
  const parsedRank = Number.parseInt(matchedRank ?? '', 10)

  if (Number.isNaN(parsedRank)) {
    return fallback
  }

  return parsedRank
}

function extractStatusLinkAndTitle(articleHtml: string): {
  statusUrl?: string
  title?: string
} {
  for (const match of articleHtml.matchAll(STATUS_LINK_REGEX)) {
    const rawUrl = decodeHtmlEntities(match[1] ?? '').trim()
    if (!rawUrl) {
      continue
    }

    const title = cleanText(match[2] ?? '')
    return {
      statusUrl: rawUrl,
      title: title || undefined,
    }
  }

  return {}
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

export const xrankingRankingParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: RankedParsedItem[] = []
  let entryIndex = 0

  for (const articleMatch of html.matchAll(ARTICLE_REGEX)) {
    const articleHtml = articleMatch[0] ?? ''
    const rawVideoUrl = VIDEO_SRC_REGEX.exec(articleHtml)?.[1]?.trim()

    if (!rawVideoUrl) {
      continue
    }

    entryIndex += 1

    const rankOrder = extractRankOrder(articleHtml, entryIndex)
    const rawPosterUrl = VIDEO_POSTER_REGEX.exec(articleHtml)?.[1]?.trim()
    const { statusUrl, title: rawTitle } = extractStatusLinkAndTitle(articleHtml)
    const normalizedStatusUrl = normalizeStatusUrl(statusUrl)
    const normalizedVideoUrl = toAbsoluteUrl(
      decodeHtmlEntities(rawVideoUrl),
      pageUrl,
    )
    const normalizedPosterUrl = rawPosterUrl
      ? toAbsoluteUrl(decodeHtmlEntities(rawPosterUrl), pageUrl)
      : undefined
    const views = VIEW_COUNT_REGEX.exec(articleHtml)?.[1]

    parsed.push({
      title: buildTitle(rankOrder, rawTitle, normalizedStatusUrl, normalizedVideoUrl),
      url: normalizedVideoUrl,
      dedupeKey: buildDedupeKey(
        normalizedVideoUrl,
        normalizedStatusUrl,
        normalizedPosterUrl,
      ),
      previewImageUrl: normalizedPosterUrl,
      summary: normalizedStatusUrl,
      rawHtmlSnippet: views ? `조회수 ${views}` : undefined,
      rankOrder,
    })
  }

  return dedupeRankedItems(parsed)
}
