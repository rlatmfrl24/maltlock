import type { ParsedItem, SiteParser } from '../types/contracts'
import { dedupeByUrlAndTitle, toAbsoluteUrl } from './utils'

const VIDEO_URL_ANCHOR_REGEX =
  /<a\s+[^>]*href=["'](https?:\/\/video\.twimg\.com\/[^"']+)["'][^>]*>\s*(?:동영상\s*URL|동영상URL|動画\s*URL|動画URL|Video\s*URL|VideoURL)\s*<\/a\s*>/gi
const RANK_MARKER_REGEX = /<img\s+[^>]*src=["'][^"']*rank\d+\.png["'][^>]*>\s*(\d+)\s*위/gi
const X_LINK_REGEX = /href=["'](https?:\/\/x\.com\/[^"']+)["']/gi
const PREVIEW_IMAGE_REGEX =
  /<img\s+[^>]*src=["'](https?:\/\/pbs\.twimg\.com\/[^"']+)["'][^>]*>/gi

const CONTEXT_WINDOW = 5000

function findLastMatch(regex: RegExp, source: string): string | undefined {
  let matched: string | undefined

  for (const match of source.matchAll(regex)) {
    matched = match[1]
  }

  return matched
}

function buildTitle(rank: string, tweetUrl: string | undefined, videoUrl: string): string {
  if (tweetUrl) {
    return `${rank}위 - ${tweetUrl}`
  }

  return `${rank}위 - ${videoUrl}`
}

export const twidougaRankingT1Parser: SiteParser = (html: string, pageUrl: string) => {
  const normalizedHtml = html.replace(/\r\n/g, '\n')
  const parsed: ParsedItem[] = []

  let entryIndex = 0
  for (const match of normalizedHtml.matchAll(VIDEO_URL_ANCHOR_REGEX)) {
    if (match.index === undefined) {
      continue
    }

    entryIndex += 1

    const videoUrl = match[1]?.trim()
    if (!videoUrl) {
      continue
    }

    const contextStart = Math.max(0, match.index - CONTEXT_WINDOW)
    const context = normalizedHtml.slice(contextStart, match.index + match[0].length)

    const rank = findLastMatch(RANK_MARKER_REGEX, context) ?? `${entryIndex}`
    const tweetUrl = findLastMatch(X_LINK_REGEX, context)?.trim()
    const previewImageUrl = findLastMatch(PREVIEW_IMAGE_REGEX, context)?.trim()

    parsed.push({
      title: buildTitle(rank, tweetUrl, videoUrl),
      url: toAbsoluteUrl(videoUrl, pageUrl),
      previewImageUrl: previewImageUrl
        ? toAbsoluteUrl(previewImageUrl, pageUrl)
        : undefined,
      summary: tweetUrl,
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
