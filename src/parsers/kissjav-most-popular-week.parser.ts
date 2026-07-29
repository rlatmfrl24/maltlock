import type { ParsedItem, SiteParser } from '../types/contracts'
import { cleanText, dedupeByUrlAndTitle, toAbsoluteUrl } from './utils'
import { canonicalPathIdentity, contentCodeIdentities } from './identities'

const KISSJAV_VIDEO_ANCHOR_REGEX =
  /<a\s+([^>]*href=["'][^"']*\/video\/[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi

function extractAttribute(source: string, attribute: string): string | undefined {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|\\s)${escapedAttribute}\\s*=\\s*["']([^"']+)["']`, 'i')
  const match = pattern.exec(source)
  return match?.[1]
}

function extractCardTitle(anchorAttributes: string, anchorInnerHtml: string): string {
  const attributeTitle = extractAttribute(anchorAttributes, 'title')

  if (attributeTitle) {
    return cleanText(attributeTitle)
  }

  const titleMatch =
    /<(?:div|strong)\s+class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|strong)>/i.exec(
      anchorInnerHtml,
    )
  return cleanText(titleMatch?.[1] ?? '')
}

function extractPreviewImage(anchorInnerHtml: string, pageUrl: string): string | undefined {
  const images = Array.from(anchorInnerHtml.matchAll(/<img\b[^>]*>/gi))

  for (const image of images) {
    const tag = image[0] ?? ''
    const candidate = (
      extractAttribute(tag, 'data-original') ??
      extractAttribute(tag, 'data-webp') ??
      extractAttribute(tag, 'src')
    )?.trim()
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

  for (const match of html.matchAll(KISSJAV_VIDEO_ANCHOR_REGEX)) {
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

    const url = toAbsoluteUrl(rawUrl, pageUrl)
    const canonicalIdentity = canonicalPathIdentity(url)
    parsed.push({
      title,
      url,
      identities: [
        ...(canonicalIdentity ? [canonicalIdentity] : []),
        ...contentCodeIdentities(title, url),
      ],
      previewImageUrl: extractPreviewImage(anchorInnerHtml, pageUrl),
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
