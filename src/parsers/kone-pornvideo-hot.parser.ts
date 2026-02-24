import type { ParsedItem, SiteParser } from '../types/contracts'
import {
  cleanText,
  decodeHtmlEntities,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'

const PACKED_ARTICLE_REGEX =
  /"id":\{"__t":"u","v":"([^"]+)"\},"title":"((?:\\.|[^"\\])*)"[\s\S]*?"preview":"([^"]+?)","has_media":true/g
const ARTICLE_ANCHOR_TAG_REGEX = /<a\b[^>]*>/gi
const PREVIEW_IMAGE_REGEX =
  /<img[^>]+crossorigin="anonymous"[^>]+src="([^"]+)"[^>]*alt="([^"]+)"[^>]*>/gi
const CONTEXT_PREVIEW_IMAGE_REGEX =
  /<img[^>]+crossorigin="anonymous"[^>]+src="([^"]+)"[^>]*>/i
const ROW_CONTEXT_WINDOW = 4000

function decodePackedString(input: string): string {
  try {
    return JSON.parse(`"${input.replace(/"/g, '\\"')}"`) as string
  } catch {
    return input
  }
}

function getSubHandle(pageUrl: string): string {
  try {
    const parsedUrl = new URL(pageUrl)
    const match = /^\/s\/([^/?#]+)/.exec(parsedUrl.pathname)
    return match?.[1] ?? 'pornvideo'
  } catch {
    return 'pornvideo'
  }
}

function getMode(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).searchParams.get('mode')
  } catch {
    return null
  }
}

function buildArticleUrl(pageUrl: string, subHandle: string, articleId: string): string {
  try {
    const url = new URL(`/s/${subHandle}/${articleId}`, pageUrl)
    const mode = getMode(pageUrl)
    if (mode) {
      url.searchParams.set('mode', mode)
    }
    return url.toString()
  } catch {
    return `https://kone.gg/s/${subHandle}/${articleId}`
  }
}

function normalizeArticleUrl(rawHref: string, pageUrl: string): string {
  try {
    const url = new URL(rawHref, pageUrl)
    const pathnameMatch = /^\/s\/([^/?#]+)\/([^/?#]+)/.exec(url.pathname)

    if (!pathnameMatch) {
      return url.toString()
    }

    const normalized = new URL(`/s/${pathnameMatch[1]}/${pathnameMatch[2]}`, pageUrl)
    const mode = url.searchParams.get('mode') ?? getMode(pageUrl)
    if (mode) {
      normalized.searchParams.set('mode', mode)
    }

    return normalized.toString()
  } catch {
    return toAbsoluteUrl(rawHref, pageUrl)
  }
}

function getAttribute(tagHtml: string, attributeName: string): string | undefined {
  const matcher = new RegExp(`${attributeName}="([^"]*)"`, 'i')
  return matcher.exec(tagHtml)?.[1]
}

function parseFromPackedPayload(html: string, pageUrl: string): ParsedItem[] {
  const parsed: ParsedItem[] = []
  const subHandle = getSubHandle(pageUrl)

  for (const match of html.matchAll(PACKED_ARTICLE_REGEX)) {
    const articleId = match[1]?.trim()
    const rawTitle = match[2]
    const rawPreviewUrl = match[3]?.trim()

    if (!articleId || !rawTitle || !rawPreviewUrl) {
      continue
    }

    const title = cleanText(decodePackedString(rawTitle))

    if (!title) {
      continue
    }

    parsed.push({
      title,
      url: buildArticleUrl(pageUrl, subHandle, articleId),
      previewImageUrl: toAbsoluteUrl(rawPreviewUrl, pageUrl),
    })
  }

  return dedupeByUrlAndTitle(parsed)
}

function parseFromDomCards(html: string, pageUrl: string): ParsedItem[] {
  const previewByTitle = new Map<string, string>()

  for (const match of html.matchAll(PREVIEW_IMAGE_REGEX)) {
    const rawPreviewUrl = match[1]?.trim()
    const rawAlt = match[2]

    if (!rawPreviewUrl || !rawAlt) {
      continue
    }

    const normalizedTitle = cleanText(decodeHtmlEntities(rawAlt)).toLowerCase()
    if (!normalizedTitle || previewByTitle.has(normalizedTitle)) {
      continue
    }

    previewByTitle.set(normalizedTitle, toAbsoluteUrl(rawPreviewUrl, pageUrl))
  }

  const parsed: ParsedItem[] = []

  for (const match of html.matchAll(ARTICLE_ANCHOR_TAG_REGEX)) {
    const anchorTagHtml = match[0]
    const rawTitle = getAttribute(anchorTagHtml, 'title')
    const rawHref = getAttribute(anchorTagHtml, 'href')

    if (!rawTitle || !rawHref) {
      continue
    }

    const href = decodeHtmlEntities(rawHref)
    if (!/^\/?s\/[^/?#]+\/[^/?#]+/i.test(href.replace(/^https?:\/\/[^/]+/i, ''))) {
      continue
    }

    const title = cleanText(decodeHtmlEntities(rawTitle))
    if (!title) {
      continue
    }

    let previewImageUrl: string | undefined
    if (match.index !== undefined) {
      const rowContext = html.slice(match.index, match.index + ROW_CONTEXT_WINDOW)
      const rowPreview = CONTEXT_PREVIEW_IMAGE_REGEX.exec(rowContext)?.[1]?.trim()
      if (rowPreview) {
        previewImageUrl = toAbsoluteUrl(rowPreview, pageUrl)
      }
    }

    if (!previewImageUrl) {
      previewImageUrl = previewByTitle.get(title.toLowerCase())
    }

    if (!previewImageUrl) {
      continue
    }

    parsed.push({
      title,
      url: normalizeArticleUrl(href, pageUrl),
      previewImageUrl,
    })
  }

  return dedupeByUrlAndTitle(parsed)
}

export const konePornvideoHotParser: SiteParser = (html: string, pageUrl: string) => {
  const domItems = parseFromDomCards(html, pageUrl)

  if (domItems.length > 0) {
    return domItems
  }

  const packedItems = parseFromPackedPayload(html, pageUrl)

  if (packedItems.length > 0) {
    return packedItems
  }

  return []
}
