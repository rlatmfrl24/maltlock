import type { ParsedItem, SiteParser } from '../types/contracts'
import { canonicalPathIdentity, sourceIdIdentity } from './identities'
import {
  cleanText,
  decodeHtmlEntities,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'

const LIST_ITEM_REGEX = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi
const LOCATION_HREF_REGEX = /location\.href\s*=\s*(['"])(.*?)\1/i
const VIDEO_PATH_REGEX = /^\/video\/([A-Za-z0-9_-]+)\/?$/

function getAttribute(tagHtml: string, attributeName: string): string | undefined {
  const quotedMatcher = new RegExp(
    `${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  )
  const quotedMatch = quotedMatcher.exec(tagHtml)
  if (quotedMatch) {
    return quotedMatch[1] ?? quotedMatch[2]
  }

  const bareMatcher = new RegExp(`${attributeName}\\s*=\\s*([^\\s>]+)`, 'i')
  return bareMatcher.exec(tagHtml)?.[1]
}

function getClassElementContent(html: string, className: string): string | undefined {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*class\\s*=\\s*(?:"[^"]*\\b${escapedClassName}\\b[^"]*"|'[^']*\\b${escapedClassName}\\b[^']*')[^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  )
  return matcher.exec(html)?.[2]
}

function getRawVideoUrl(attributesHtml: string, cardHtml: string): string | undefined {
  const onclick = getAttribute(attributesHtml, 'onclick')
  const onclickUrl = onclick ? LOCATION_HREF_REGEX.exec(onclick)?.[2]?.trim() : undefined
  if (onclickUrl) {
    return decodeHtmlEntities(onclickUrl)
  }

  const anchorTag = /<a\b[^>]*>/i.exec(cardHtml)?.[0]
  const anchorUrl = anchorTag ? getAttribute(anchorTag, 'href')?.trim() : undefined
  return anchorUrl ? decodeHtmlEntities(anchorUrl) : undefined
}

function getVideoIdentity(
  rawUrl: string,
  pageUrl: string,
): { id: string; url: string } | undefined {
  try {
    const parsedUrl = new URL(rawUrl, pageUrl)
    const videoId = VIDEO_PATH_REGEX.exec(parsedUrl.pathname)?.[1]
    if (!videoId) {
      return undefined
    }

    return {
      id: videoId,
      url: new URL(`/video/${videoId}`, pageUrl).toString(),
    }
  } catch {
    return undefined
  }
}

function getPreviewImageUrl(cardHtml: string, pageUrl: string): string | undefined {
  const thumbHtml = getClassElementContent(cardHtml, 'thumb')
  const imageTag = thumbHtml ? /<img\b[^>]*>/i.exec(thumbHtml)?.[0] : undefined
  const rawUrl = imageTag ? getAttribute(imageTag, 'src')?.trim() : undefined

  if (!rawUrl || rawUrl.startsWith('data:')) {
    return undefined
  }

  return toAbsoluteUrl(decodeHtmlEntities(rawUrl), pageUrl)
}

export const ydkoreaPopularBestParser: SiteParser = (html: string, pageUrl: string) => {
  const parsed: ParsedItem[] = []

  for (const match of html.matchAll(LIST_ITEM_REGEX)) {
    const attributesHtml = match[1] ?? ''
    const cardHtml = match[2] ?? ''
    const rawVideoUrl = getRawVideoUrl(attributesHtml, cardHtml)
    const rawTitle = getClassElementContent(cardHtml, 'title')

    if (!rawVideoUrl || !rawTitle) {
      continue
    }

    const video = getVideoIdentity(rawVideoUrl, pageUrl)
    const title = cleanText(rawTitle)
    const previewImageUrl = getPreviewImageUrl(cardHtml, pageUrl)

    if (!video || !title || !previewImageUrl) {
      continue
    }

    const canonicalIdentity = canonicalPathIdentity(video.url)
    parsed.push({
      title,
      url: video.url,
      previewImageUrl,
      dedupeKey: `ydkorea:video:${video.id}`,
      identities: [
        sourceIdIdentity(video.id),
        ...(canonicalIdentity ? [canonicalIdentity] : []),
      ],
    })
  }

  return dedupeByUrlAndTitle(parsed)
}
