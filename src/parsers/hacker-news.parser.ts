import type { ParsedItem, SiteParser } from '../types/contracts'
import {
  cleanText,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'

const HN_ITEM_REGEX =
  /<tr class=["']athing["'][\s\S]*?<span class=["']titleline["'][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g

export const hackerNewsParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: ParsedItem[] = []

  for (const match of html.matchAll(HN_ITEM_REGEX)) {
    const rawUrl = match[1]
    const rawTitle = match[2]

    if (!rawUrl || !rawTitle) {
      continue
    }

    const title = cleanText(rawTitle)

    if (!title) {
      continue
    }

    parsed.push({
      title,
      url: toAbsoluteUrl(rawUrl, pageUrl),
      rawHtmlSnippet: cleanText(rawTitle),
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
