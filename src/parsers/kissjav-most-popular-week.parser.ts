import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, dedupeByUrlAndTitle, toAbsoluteUrl } from './utils'

const KISSJAV_CARD_REGEX =
  /<div class="thumb\s+thumb_rel\s+item[^"]*"[\s\S]*?<a\s+([^>]*?)>([\s\S]*?)<\/a>[\s\S]*?<\/div>/gi

function extractAttribute(source: string, attribute: string): string | undefined {
  const pattern = new RegExp(`${attribute}=["']([^"']+)["']`, 'i')
  const match = pattern.exec(source)
  return match?.[1]
}

function extractCardTitle(anchorAttributes: string, anchorInnerHtml: string): string {
  const attributeTitle = extractAttribute(anchorAttributes, 'title')

  if (attributeTitle) {
    return cleanText(attributeTitle)
  }

  const titleMatch = /<div class="title"[^>]*>([\s\S]*?)<\/div>/i.exec(anchorInnerHtml)
  return cleanText(titleMatch?.[1] ?? '')
}

function extractPreviewImage(anchorInnerHtml: string, pageUrl: string): string | undefined {
  const images = Array.from(
    anchorInnerHtml.matchAll(/<img[^>]+(?:data-original|src)=["']([^"']+)["'][^>]*>/gi),
  )

  for (const image of images) {
    const candidate = image[1]?.trim()

    if (!candidate || candidate.startsWith('data:')) {
      continue
    }

    return toAbsoluteUrl(candidate, pageUrl)
  }

  return undefined
}

export const kissjavMostPopularWeekParser: SiteParser = (
  html: string,
  pageUrl: string,
) => {
  const parsed: ParsedItem[] = []

  for (const match of html.matchAll(KISSJAV_CARD_REGEX)) {
    const anchorAttributes = match[1] ?? ''
    const anchorInnerHtml = match[2] ?? ''

    const rawUrl = extractAttribute(anchorAttributes, 'href')

    if (!rawUrl || !rawUrl.includes('/video/')) {
      continue
    }

    const title = extractCardTitle(anchorAttributes, anchorInnerHtml)

    if (!title) {
      continue
    }

    parsed.push({
      title,
      url: toAbsoluteUrl(rawUrl, pageUrl),
      previewImageUrl: extractPreviewImage(anchorInnerHtml, pageUrl),
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
