import type { ParsedItem, SiteParser } from '../types/contracts'
import { devtoLatestParser } from './devto-latest.parser'
import { hackerNewsParser } from './hacker-news.parser'
import { kissjavMostPopularWeekParser } from './kissjav-most-popular-week.parser'
import { konePornvideoHotParser } from './kone-pornvideo-hot.parser'
import { missavWeeklyViewsParser } from './missav-weekly-views.parser'
import { tcafeD2001HotBestParser } from './tcafe-d2001-hot-best.parser'
import { torrentbotTopicTop20Parser } from './torrentbot-topic-top20.parser'
import { twidougaRankingT1Parser } from './twidouga-ranking-t1.parser'

const parserRegistry: Record<string, SiteParser> = {
  'hacker-news': hackerNewsParser,
  'devto-latest': devtoLatestParser,
  'kissjav-most-popular-week': kissjavMostPopularWeekParser,
  'missav-weekly-views': missavWeeklyViewsParser,
  'tcafe-d2001-hot-best': tcafeD2001HotBestParser,
  'twidouga-ranking-t1': twidougaRankingT1Parser,
  'torrentbot-topic-top20': torrentbotTopicTop20Parser,
  'kone-pornvideo-hot': konePornvideoHotParser,
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
