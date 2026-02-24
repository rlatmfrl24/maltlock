import type { ParsedItem, SiteParser } from '../types/contracts'
import {
  cleanText,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'

const DEVTO_ARTICLE_LINK_REGEX =
  /<a[^>]*id=["']article-link-[^"']+["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g

const DEVTO_HEADING_LINK_REGEX =
  /<h2[^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/g

export const devtoLatestParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: ParsedItem[] = []

  for (const match of html.matchAll(DEVTO_ARTICLE_LINK_REGEX)) {
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

  if (parsed.length === 0) {
    for (const match of html.matchAll(DEVTO_HEADING_LINK_REGEX)) {
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
  }

  return dedupeByUrlAndTitle(parsed)
}
