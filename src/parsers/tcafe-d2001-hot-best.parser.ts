import type { ParsedItem, SiteParser } from '../types/contracts'
import {
  cleanText,
  decodeHtmlEntities,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'
import { canonicalPathIdentity, sourceIdIdentity } from './identities'

const HOT_SECTION_REGEX =
  /<div\b[^>]*class=(?:"[^"]*\bboard-hot-title\b[^"]*"|'[^']*\bboard-hot-title\b[^']*')[^>]*>([\s\S]*?)<\/div>\s*<div\b[^>]*class=(?:"[^"]*\bmiso-post-list\b[^"]*"|'[^']*\bmiso-post-list\b[^']*')[^>]*>[\s\S]*?<ul\b[^>]*class=(?:"[^"]*\bpost-list\b[^"]*"|'[^']*\bpost-list\b[^']*')[^>]*>([\s\S]*?)<\/ul>/gi
const HOT_ROW_REGEX =
  /<li\b[^>]*class=(?:"[^"]*\bpost-row\b[^"]*"|'[^']*\bpost-row\b[^']*')[^>]*>[\s\S]*?<a\b[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>\s*<\/li>/gi
const COMMENT_COUNT_REGEX =
  /<span\b[^>]*class=(?:"[^"]*\bcount\b[^"]*"|'[^']*\bcount\b[^']*')[^>]*>\s*\+?\s*(\d+)\s*<\/span>/i

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

function buildDedupeKey(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const boTable = parsed.searchParams.get('bo_table')
    const wrId = parsed.searchParams.get('wr_id')

    if (!boTable || !wrId) {
      return undefined
    }

    return `tcafe:path:${parsed.pathname}?bo_table=${boTable}&wr_id=${wrId}`
  } catch {
    return undefined
  }
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
      const rawUrl = rowMatch[1]?.trim() ?? rowMatch[2]?.trim()
      const rowAnchorHtml = rowMatch[3] ?? ''
      const title = normalizeTitle(rowAnchorHtml)

      if (!rawUrl || !title) {
        continue
      }

      const canonicalUrl = decodeHtmlEntities(rawUrl)
      const absoluteUrl = toAbsoluteUrl(canonicalUrl, pageUrl)
      const commentCount = COMMENT_COUNT_REGEX.exec(rowAnchorHtml)?.[1]
      const summary = commentCount
        ? `${sectionLabel} · 댓글 +${commentCount}`
        : sectionLabel

      const parsedUrl = new URL(absoluteUrl)
      const wrId = parsedUrl.searchParams.get('wr_id')
      const canonicalIdentity = canonicalPathIdentity(absoluteUrl)
      parsed.push({
        title,
        url: absoluteUrl,
        dedupeKey: buildDedupeKey(absoluteUrl),
        identities: [
          ...(wrId ? [sourceIdIdentity(wrId)] : []),
          ...(canonicalIdentity ? [canonicalIdentity] : []),
        ],
        summary,
      })
    }
  }

  return dedupeByUrlAndTitle(parsed)
}
