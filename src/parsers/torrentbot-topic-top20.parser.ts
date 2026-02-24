import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, dedupeByUrlAndTitle, toAbsoluteUrl } from './utils'

const ROW_REGEX = /<ul class="td ufl">([\s\S]*?)<\/ul>/gi
const TITLE_LINK_REGEX =
  /<li class="tit[^"]*">\s*<a href="([^"]+)">([\s\S]*?)<\/a>\s*<\/li>/i
const PLAIN_LI_REGEX = /<li>\s*([^<]+?)\s*<\/li>/gi

export const torrentbotTopicTop20Parser: SiteParser = (
  html: string,
  pageUrl: string,
) => {
  const parsed: ParsedItem[] = []

  for (const rowMatch of html.matchAll(ROW_REGEX)) {
    const rowHtml = rowMatch[1] ?? ''
    const titleMatch = TITLE_LINK_REGEX.exec(rowHtml)

    if (!titleMatch) {
      continue
    }

    const rawUrl = titleMatch[1]?.trim()
    const rawTitle = titleMatch[2] ?? ''

    if (!rawUrl) {
      continue
    }

    const plainValues = Array.from(rowHtml.matchAll(PLAIN_LI_REGEX)).map((match) =>
      cleanText(match[1] ?? ''),
    )

    const rank = plainValues[0] ?? ''
    const date = plainValues[1] ?? ''
    const title = cleanText(rawTitle)

    if (!title) {
      continue
    }

    parsed.push({
      title,
      url: toAbsoluteUrl(rawUrl, pageUrl),
      summary: `${rank ? `${rank}위` : ''}${rank && date ? ' · ' : ''}${date}`,
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
