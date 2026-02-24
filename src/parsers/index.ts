import type { ParsedItem, SiteParser } from '../types/contracts'
import { devtoLatestParser } from './devto-latest.parser'
import { hackerNewsParser } from './hacker-news.parser'

const parserRegistry: Record<string, SiteParser> = {
  'hacker-news': hackerNewsParser,
  'devto-latest': devtoLatestParser,
}

export function parseByParserId(
  parserId: string,
  html: string,
  pageUrl: string,
): ParsedItem[] {
  const parser = parserRegistry[parserId]

  if (!parser) {
    throw new Error(`Unknown parserId: ${parserId}`)
  }

  return parser(html, pageUrl)
}

export { parserRegistry }
