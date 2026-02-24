import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, dedupeByUrlAndTitle, toAbsoluteUrl } from './utils'

const MISSAV_ITEM_REGEX =
  /<div class="item">[\s\S]*?<a href="([^"]+)" class="poster">[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>[\s\S]*?<a href="([^"]+)" class="title">([\s\S]*?)<\/a>[\s\S]*?<\/div>\s*<\/div>/gi

function normalizeTitle(rawHtml: string): string {
  return cleanText(rawHtml)
}

export const missavWeeklyViewsParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: ParsedItem[] = []

  for (const match of html.matchAll(MISSAV_ITEM_REGEX)) {
    const posterHref = match[1]
    const previewImageUrl = match[2]
    const titleHref = match[3]
    const rawTitle = match[4]

    if (!posterHref || !titleHref || !rawTitle) {
      continue
    }

    const canonicalHref = titleHref.trim() || posterHref.trim()

    if (!canonicalHref.includes('/v/')) {
      continue
    }

    const title = normalizeTitle(rawTitle)

    if (!title) {
      continue
    }

    parsed.push({
      title,
      url: toAbsoluteUrl(canonicalHref, pageUrl),
      previewImageUrl: previewImageUrl
        ? toAbsoluteUrl(previewImageUrl.trim(), pageUrl)
        : undefined,
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
