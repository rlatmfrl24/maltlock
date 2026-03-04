import type { ParsedItem, SiteParser } from '../types/contracts'
import {
  cleanText,
  decodeHtmlEntities,
  dedupeByUrlAndTitle,
  toAbsoluteUrl,
} from './utils'

const PACKED_ARTICLE_REGEX =
  /"id":\{"__t":"u","v":"([^"]+)"\},"title":"((?:\\.|[^"\\])*)"[\s\S]*?"preview":"((?:\\.|[^"\\])*)"/g
const NEXT_FLIGHT_CHUNK_REGEX =
  /self\.__next_f\.push\(\[\s*1\s*,\s*(['"])((?:\\.|(?!\1)[\s\S])*)\1\s*,?\s*\]\);?/g
const ARTICLE_ANCHOR_TAG_REGEX = /<a\b[^>]*>/gi
const IMAGE_TAG_REGEX = /<img\b[^>]*>/gi
const CONTEXT_IMAGE_TAG_REGEX = /<img\b[^>]*>/i
const ROW_CONTEXT_WINDOW = 4000

function decodePackedString(input: string): string {
  try {
    return JSON.parse(`"${input.replace(/"/g, '\\"')}"`) as string
  } catch {
    return input
  }
}

function decodeJsStringLiteralChunk(input: string): string {
  let decoded = ''

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (char !== '\\') {
      decoded += char
      continue
    }

    const next = input[i + 1]
    if (!next) {
      decoded += '\\'
      continue
    }

    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 2, i + 6))) {
      decoded += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16))
      i += 5
      continue
    }

    if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(input.slice(i + 2, i + 4))) {
      decoded += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 4), 16))
      i += 3
      continue
    }

    switch (next) {
      case 'n':
        decoded += '\n'
        break
      case 'r':
        decoded += '\r'
        break
      case 't':
        decoded += '\t'
        break
      case 'b':
        decoded += '\b'
        break
      case 'f':
        decoded += '\f'
        break
      case 'v':
        decoded += '\v'
        break
      case '0':
        decoded += '\0'
        break
      case '\n':
        break
      case '\r':
        if (input[i + 2] === '\n') {
          i += 1
        }
        break
      default:
        decoded += next
        break
    }

    i += 1
  }

  return decoded
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

function parseFromPackedPayload(html: string, pageUrl: string): ParsedItem[] {
  let packedPayload = ''
  for (const match of html.matchAll(NEXT_FLIGHT_CHUNK_REGEX)) {
    const chunk = match[2]
    if (!chunk) {
      continue
    }

    packedPayload += decodeJsStringLiteralChunk(chunk)
  }

  if (!packedPayload) {
    packedPayload = html
  }

  const parsed: ParsedItem[] = []
  const subHandle = getSubHandle(pageUrl)

  for (const match of packedPayload.matchAll(PACKED_ARTICLE_REGEX)) {
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

  for (const match of html.matchAll(IMAGE_TAG_REGEX)) {
    const imageTagHtml = match[0]
    const rawPreviewUrl = getAttribute(imageTagHtml, 'src')?.trim()
    const rawAlt = getAttribute(imageTagHtml, 'alt')

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
      const rowPreviewTag = CONTEXT_IMAGE_TAG_REGEX.exec(rowContext)?.[0]
      const rowPreview = rowPreviewTag
        ? getAttribute(rowPreviewTag, 'src')?.trim()
        : undefined
      if (rowPreview && !rowPreview.startsWith('data:')) {
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
  const packedItems = parseFromPackedPayload(html, pageUrl)

  if (packedItems.length > 0) {
    return packedItems
  }

  const domItems = parseFromDomCards(html, pageUrl)

  if (domItems.length > 0) {
    return domItems
  }

  return []
}
