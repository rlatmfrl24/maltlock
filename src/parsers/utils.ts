export function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ')
}

export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

export function cleanText(input: string): string {
  return normalizeWhitespace(decodeHtmlEntities(stripTags(input)))
}

export function toAbsoluteUrl(rawUrl: string, pageUrl: string): string {
  try {
    return new URL(rawUrl, pageUrl).toString()
  } catch {
    return rawUrl
  }
}

export function clipText(input: string, limit: number): string {
  if (input.length <= limit) {
    return input
  }

  return `${input.slice(0, limit - 3)}...`
}

export function dedupeByUrlAndTitle<T extends { title: string; url: string }>(
  items: T[],
): T[] {
  const seen = new Set<string>()
  const results: T[] = []

  for (const item of items) {
    const key = `${item.url.toLowerCase()}|${item.title.trim().toLowerCase()}`

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    results.push(item)
  }

  return results
}
