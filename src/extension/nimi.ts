export type NimiView = 'ranking' | 'realtime' | 'recent'
export type NimiPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly'

const ACTIVE_TAB_ELEMENT_REGEX =
  /<(?:button|a)\b[^>]*class=["'][^"']*(?:tab-active|bg-violet-500\/20)[^"']*["'][^>]*>([\s\S]*?)<\/(?:button|a)>/gi
const ACTIVE_PERIOD_BUTTON_REGEX =
  /<button\b[^>]*class=["'][^"']*shadow-violet-500\/50[^"']*["'][^>]*>([\s\S]*?)<\/button>/gi

const PERIOD_BY_QUERY_VALUE: Record<string, NimiPeriod> = {
  hour: 'hourly',
  hourly: 'hourly',
  day: 'daily',
  daily: 'daily',
  week: 'weekly',
  weekly: 'weekly',
  month: 'monthly',
  monthly: 'monthly',
}

function stripHtmlTags(input: string): string {
  return input.replace(/<[^>]+>/g, ' ')
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

function extractHtmlText(input: string): string {
  return normalizeWhitespace(stripHtmlTags(input))
}

function normalizePathSegment(input: string): string {
  return input.trim().toLowerCase()
}

function getNimiViewFromTabUrl(tabUrl: string): NimiView | undefined {
  try {
    const segments = new URL(tabUrl)
      .pathname.split('/')
      .map(normalizePathSegment)
      .filter(Boolean)

    for (const segment of segments) {
      if (segment === 'ranking' || segment === 'realtime' || segment === 'recent') {
        return segment
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

function getNimiPeriodFromTabUrl(tabUrl: string): NimiPeriod | undefined {
  try {
    const parsed = new URL(tabUrl)

    for (const key of ['period', 'time', 'range', 'filter']) {
      const rawValue = normalizePathSegment(parsed.searchParams.get(key) ?? '')
      const matched = PERIOD_BY_QUERY_VALUE[rawValue]

      if (matched) {
        return matched
      }
    }
  } catch {
    return undefined
  }

  return undefined
}

export function getNimiActiveView(html: string, tabUrl: string): NimiView {
  const viewFromUrl = getNimiViewFromTabUrl(tabUrl)
  if (viewFromUrl) {
    return viewFromUrl
  }

  for (const match of html.matchAll(ACTIVE_TAB_ELEMENT_REGEX)) {
    const label = extractHtmlText(match[1] ?? '')
    if (!label) {
      continue
    }

    if (label.includes('실시간')) {
      return 'realtime'
    }

    if (label.includes('신규')) {
      return 'recent'
    }

    if (label.includes('인기')) {
      return 'ranking'
    }
  }

  return 'ranking'
}

export function getNimiActivePeriod(html: string, tabUrl: string): NimiPeriod {
  const periodFromUrl = getNimiPeriodFromTabUrl(tabUrl)
  if (periodFromUrl) {
    return periodFromUrl
  }

  for (const match of html.matchAll(ACTIVE_PERIOD_BUTTON_REGEX)) {
    const label = extractHtmlText(match[1] ?? '')
    if (!label) {
      continue
    }

    if (label.includes('1달') || label.includes('1개월')) {
      return 'monthly'
    }

    if (label.includes('1주')) {
      return 'weekly'
    }

    if (label.includes('24시간') || label.includes('1일')) {
      return 'daily'
    }

    if (label.includes('1시간')) {
      return 'hourly'
    }
  }

  return 'hourly'
}

export function buildNimiApiUrl(html: string, tabUrl: string): string | undefined {
  let origin: string

  try {
    origin = new URL(tabUrl).origin
  } catch {
    return undefined
  }

  const activeView = getNimiActiveView(html, tabUrl)

  if (activeView === 'ranking') {
    const activePeriod = getNimiActivePeriod(html, tabUrl)
    return `${origin}/api/tw/ranking?period=${activePeriod}`
  }

  return `${origin}/api/tw/${activeView}`
}
