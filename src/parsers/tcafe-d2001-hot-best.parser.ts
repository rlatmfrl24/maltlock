import type { ParsedItem, SiteParser } from '../types/contracts'
import {
  cleanText,
  decodeHtmlEntities,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'

const HOT_SECTION_REGEX =
  /<div class="board-hot-title">([\s\S]*?)<\/div>\s*<div class="miso-post-list">[\s\S]*?<ul class="post-list">([\s\S]*?)<\/ul>/gi
const HOT_ROW_REGEX =
  /<li class="post-row">[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi
const COMMENT_COUNT_REGEX = /<span class="count[^"]*">\s*\+?(\d+)\s*<\/span>/i

function toSectionLabel(rawTitleHtml: string): string | undefined {
  const title = cleanText(rawTitleHtml)

  if (title.includes('오늘의 베스트')) {
    return '일간 베스트'
  }

  if (title.includes('주간 베스트')) {
    return '주간 베스트'
  }

  return undefined
}

function normalizeTitle(rawAnchorHtml: string): string {
  const cleaned = cleanText(rawAnchorHtml)
  return cleaned.replace(/^\+\d+\s*/, '').trim()
}

export const tcafeD2001HotBestParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: ParsedItem[] = []

  for (const sectionMatch of html.matchAll(HOT_SECTION_REGEX)) {
    const sectionLabel = toSectionLabel(sectionMatch[1] ?? '')
    const listHtml = sectionMatch[2] ?? ''

    if (!sectionLabel) {
      continue
    }

    for (const rowMatch of listHtml.matchAll(HOT_ROW_REGEX)) {
      const rawUrl = rowMatch[1]?.trim()
      const rowAnchorHtml = rowMatch[2] ?? ''
      const title = normalizeTitle(rowAnchorHtml)

      if (!rawUrl || !title) {
        continue
      }

      const canonicalUrl = decodeHtmlEntities(rawUrl)
      const commentCount = COMMENT_COUNT_REGEX.exec(rowAnchorHtml)?.[1]
      const summary = commentCount
        ? `${sectionLabel} · 댓글 +${commentCount}`
        : sectionLabel

      parsed.push({
        title,
        url: toAbsoluteUrl(canonicalUrl, pageUrl),
        summary,
      })
    }
  }

  return dedupeByUrlAndTitle(parsed)
}
