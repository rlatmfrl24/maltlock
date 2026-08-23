export type NimiView = 'ranking' | 'realtime' | 'recent'
export type NimiPeriod = 'hourly' | 'daily' | 'weekly' | 'monthly'
type NimiApiPeriod = 'hour' | 'day' | 'week' | 'month'

const ACTIVE_TAB_ELEMENT_REGEX =
  /<(?:button|a)\b[^>]*class=["'][^"']*(?:tab-active|bg-violet-500\/20)[^"']*["'][^>]*>([\s\S]*?)<\/(?:button|a)>/gi
const ACTIVE_PERIOD_BUTTON_REGEX =
  /<button\b[^>]*class=["'][^"']*shadow-violet-500\/50[^"']*["'][^>]*>([\s\S]*?)<\/button>/gi
const VIDEO_API_URL_REGEX = /\bvideoApiUrl\s*:\s*["']([^"']+)["']/i
const CURRENT_NIMI_HOST = 'video.nimi.wiki'
const CURRENT_NIMI_API_URL = 'https://api.nimi.wiki/video'

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
const API_PERIOD_BY_PERIOD: Record<NimiPeriod, NimiApiPeriod> = {
  hourly: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
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

    const segments = parsed.pathname
      .split('/')
      .map(normalizePathSegment)
      .filter(Boolean)

    for (const segment of segments) {
      const matched = PERIOD_BY_QUERY_VALUE[segment]

      if (matched) {
        return matched
      }
    }

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

function getNimiApiOrigin(tabUrl: string): string | undefined {
  try {
    const parsed = new URL(tabUrl)

    if (parsed.hostname === 'tw.nimi.wiki') {
      return 'https://tw1.nimi.wiki'
    }

    return parsed.origin
  } catch {
    return undefined
  }
}

function normalizeNimiVideoApiUrl(input: string): string | undefined {
  try {
    const parsed = new URL(decodeURIComponent(input.replace(/&amp;/gi, '&')))

    if (
      parsed.protocol !== 'https:' ||
      (parsed.hostname !== 'nimi.wiki' && !parsed.hostname.endsWith('.nimi.wiki'))
    ) {
      return undefined
    }

    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

function getConfiguredVideoApiUrl(html: string): string | undefined {
  const rawApiUrl = VIDEO_API_URL_REGEX.exec(html)?.[1]
  return rawApiUrl ? normalizeNimiVideoApiUrl(rawApiUrl) : undefined
}

function isCurrentNimiHost(tabUrl: string): boolean {
  try {
    return new URL(tabUrl).hostname === CURRENT_NIMI_HOST
  } catch {
    return false
  }
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
  const activeView = getNimiActiveView(html, tabUrl)
  const currentApiUrl = getConfiguredVideoApiUrl(html) ??
    (isCurrentNimiHost(tabUrl) ? CURRENT_NIMI_API_URL : undefined)

  if (currentApiUrl) {
    if (activeView === 'ranking') {
      const activePeriod = getNimiActivePeriod(html, tabUrl)
      return `${currentApiUrl}/tw/ranking/${API_PERIOD_BY_PERIOD[activePeriod]}`
    }

    return `${currentApiUrl}/tw/${activeView}`
  }

  const legacyOrigin = getNimiApiOrigin(tabUrl)
  if (!legacyOrigin) {
    return undefined
  }

  if (activeView === 'ranking') {
    const activePeriod = getNimiActivePeriod(html, tabUrl)
    return `${legacyOrigin}/api/tw/ranking/${API_PERIOD_BY_PERIOD[activePeriod]}`
  }

  return `${legacyOrigin}/api/tw/${activeView}`
}
