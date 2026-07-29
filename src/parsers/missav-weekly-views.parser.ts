import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, dedupeByUrlAndTitle, toAbsoluteUrl } from './utils'
import { canonicalPathIdentity, contentCodeIdentities } from './identities'

const CARD_START_REGEX =
  /<div\b[^>]*class=(["'])[^"']*\bcard\b[^"']*\1[^>]*>/gi
const CARD_TITLE_LINK_REGEX =
  /<a\b(?=[^>]*class=(["'])[^"']*\bcard__link\b[^"']*\1)[^>]*>[\s\S]*?<\/a>/i
const CARD_IMAGE_REGEX =
  /<img\b(?=[^>]*class=(["'])[^"']*\bcard__img\b[^"']*\1)[^>]*>/i
const CARD_PREVIEW_REGEX =
  /<div\b(?=[^>]*class=(["'])[^"']*\bcard__poster\b[^"']*\1)[^>]*>/i

function normalizeTitle(rawHtml: string): string {
  return cleanText(rawHtml)
}

function getAttribute(tagHtml: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, 'i')
  return pattern.exec(tagHtml)?.[2]?.trim()
}

function getVideoDedupeKey(rawUrl: string, pageUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl, pageUrl)

    if (!/^\/[^/]+\/v\/[^/?#]+$/i.test(url.pathname)) {
      return undefined
    }

    return `missav:path:${url.pathname.toLowerCase()}`
  } catch {
    return undefined
  }
}

function getCardBlocks(html: string): string[] {
  const starts = [...html.matchAll(CARD_START_REGEX)]
    .map((match) => match.index)
    .filter((index): index is number => typeof index === 'number')

  return starts.map((start, index) => {
    const nextStart = starts[index + 1] ?? html.length
    return html.slice(start, nextStart)
  })
}

export const missavWeeklyViewsParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: ParsedItem[] = []

  for (const cardHtml of getCardBlocks(html)) {
    const titleLink = CARD_TITLE_LINK_REGEX.exec(cardHtml)?.[0]

    if (!titleLink) {
      continue
    }

    const href = getAttribute(titleLink, 'href')
    const title = normalizeTitle(titleLink)

    if (!href || !title || !href.includes('/v/')) {
      continue
    }

    const imageTag = CARD_IMAGE_REGEX.exec(cardHtml)?.[0]
    const previewTag = CARD_PREVIEW_REGEX.exec(cardHtml)?.[0]
    const previewImageUrl =
      getAttribute(imageTag ?? '', 'src') ?? getAttribute(previewTag ?? '', 'data-preview')

    const url = toAbsoluteUrl(href, pageUrl)
    const canonicalIdentity = canonicalPathIdentity(url)
    parsed.push({
      title,
      url,
      dedupeKey: getVideoDedupeKey(href, pageUrl),
      identities: [
        ...(canonicalIdentity ? [canonicalIdentity] : []),
        ...contentCodeIdentities(title, url),
      ],
      previewImageUrl: previewImageUrl
        ? toAbsoluteUrl(previewImageUrl.trim(), pageUrl)
        : undefined,
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
