import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { targetSites } from '../config/targets'
import type { ParsedItem } from '../types/contracts'
import { collectParserHealthIssues, type ParserHealthExpectation } from './health'
import { parseByParserId, parserRegistry } from './index'

interface ParserHealthCase {
  name: string
  siteId: string
  fixture: string
  pageUrl: string
  expectation: ParserHealthExpectation
  primary?: boolean
}

const cases: ParserHealthCase[] = [
  {
    name: 'KissJAV current cards',
    siteId: 'kissjav-most-popular-week',
    fixture: 'kissjav_new.html',
    pageUrl: 'https://kissjav.com/most-popular/?sort_by=video_viewed_week',
    expectation: { exactCount: 3, preview: 'all', dedupeKey: 'optional' },
    primary: true,
  },
  {
    name: '123AV weekly listing',
    siteId: 'missav-weekly-views',
    fixture: 'missav_123av.html',
    pageUrl: 'https://123av.com/ko/all?sort=week',
    expectation: { minimumCount: 11, preview: 'all', dedupeKey: 'required' },
    primary: true,
  },
  {
    name: 'TwiDouga ranking',
    siteId: 'twidouga-ranking-t1',
    fixture: 'twdouga_example.html',
    pageUrl: 'https://www.twidouga.net/ko/ranking_t1.php',
    expectation: { minimumCount: 9, preview: 'all', dedupeKey: 'required' },
    primary: true,
  },
  {
    name: 'Nimi API ranking',
    siteId: 'nimi-tw-ranking',
    fixture: 'nimi_ranking_example.json',
    pageUrl: 'https://tw1.nimi.wiki/ko/ranking/week',
    expectation: { minimumCount: 16, preview: 'all', dedupeKey: 'required' },
    primary: true,
  },
  {
    name: 'Nimi HTML fallback excludes thumbnail-only cards',
    siteId: 'nimi-tw-ranking',
    fixture: 'nimi_example.html',
    pageUrl: 'https://tw1.nimi.wiki/ko/ranking/week',
    expectation: { exactCount: 0, preview: 'none', dedupeKey: 'optional' },
  },
  {
    name: 'Kone current hot listing',
    siteId: 'kone-pornvideo-hot',
    fixture: 'kone_new.html',
    pageUrl: 'https://kone.gg/s/pornvideo?mode=hot',
    expectation: { minimumCount: 21, preview: 'all', dedupeKey: 'required' },
    primary: true,
  },
  {
    name: 'Tcafe current best widget',
    siteId: 'tcafe-d2001-hot-best',
    fixture: 'tcafe_new.html',
    pageUrl: 'https://tcafe21.com/bbs/board.php?bo_table=D2001',
    expectation: { exactCount: 10, preview: 'none', dedupeKey: 'required' },
    primary: true,
  },
]

function loadFixture(name: string): string {
  return readFileSync(new URL(`../test/fixtures/parsers/${name}`, import.meta.url), 'utf-8')
}

describe('active parser health coverage', () => {
  it('registers a parser and primary fixture for every active target', () => {
    for (const site of targetSites) {
      expect(parserRegistry[site.parserId], `${site.id} parser`).toBeTypeOf('function')
      expect(
        cases.some((healthCase) => healthCase.siteId === site.id && healthCase.primary),
        `${site.id} primary fixture`,
      ).toBe(true)
    }
  })
})

describe.each(cases)('$name', (healthCase) => {
  it('satisfies the shared parser contract deterministically', () => {
    const site = targetSites.find((candidate) => candidate.id === healthCase.siteId)
    expect(site).toBeDefined()

    const input = loadFixture(healthCase.fixture)
    const first = parseByParserId(site?.parserId ?? '', input, healthCase.pageUrl)
    const second = parseByParserId(site?.parserId ?? '', input, healthCase.pageUrl)

    expect(collectParserHealthIssues(first, healthCase.expectation)).toEqual([])
    expect(second).toEqual(first)
    for (const item of first) {
      expect(item.identities?.length, `${healthCase.siteId} identity`).toBeGreaterThan(0)
      expect(new Set(item.identities?.map((identity) =>
        `${identity.scope}:${identity.kind}:${identity.value}`,
      )).size).toBe(item.identities?.length)
    }
  })
})

describe('parser health issue detection', () => {
  it('reports invalid fields and duplicate keys', () => {
    const malformedItems: ParsedItem[] = [
      { title: '', url: 'not-a-url', dedupeKey: 'same' },
      { title: 'Valid title', url: 'https://example.com/2', dedupeKey: 'same' },
    ]

    const issueCodes = collectParserHealthIssues(malformedItems, {
      exactCount: 3,
      preview: 'all',
      dedupeKey: 'required',
    }).map((issue) => issue.code)

    expect(issueCodes).toEqual([
      'COUNT_MISMATCH',
      'EMPTY_TITLE',
      'INVALID_URL',
      'PREVIEW_MISSING',
      'DEDUPE_KEY_DUPLICATE',
    ])
  })
})
