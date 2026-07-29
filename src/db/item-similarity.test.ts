import { describe, expect, it } from 'vitest'
import type { CrawledItem } from '../types/contracts'
import {
  calculateDiceScore,
  createTitleBands,
  matchSimilarItems,
  normalizeTitleForSimilarity,
} from './item-similarity'

function item(overrides: Partial<CrawledItem>): CrawledItem {
  return {
    id: overrides.id ?? 'item',
    siteId: overrides.siteId ?? 'site',
    title: overrides.title ?? 'Example sufficiently long title',
    url: overrides.url ?? 'https://example.com/item',
    crawledAt: overrides.crawledAt ?? 1,
    ...overrides,
  }
}

describe('item similarity', () => {
  it('removes rank, file size, bracket tags, and punctuation', () => {
    expect(normalizeTitleForSimilarity('1위 [FHD] Sample: Great Video (1.2GB)!!')).toBe(
      'sample great video',
    )
  })

  it('creates four deterministic minhash bands', () => {
    const title = normalizeTitleForSimilarity('A sufficiently long deterministic title')
    expect(createTitleBands(title)).toHaveLength(4)
    expect(createTitleBands(title)).toEqual(createTitleBands(title))
  })

  it('groups exact normalized titles but excludes short titles', () => {
    expect(
      matchSimilarItems(
        item({ title: '1위 [HD] Example Amazing Video 1.2GB' }),
        item({ id: 'two', title: '2위 Example Amazing Video 900MB' }),
      ),
    ).toEqual({ reason: 'title-exact', score: 1 })
    expect(
      matchSimilarItems(item({ title: 'Short title' }), item({ id: 'two', title: 'Short title' })),
    ).toBeUndefined()
  })

  it('blocks fuzzy grouping when explicit content codes conflict', () => {
    const first = item({
      title: 'Example Amazing Video Complete Edition',
      identities: [{ kind: 'content-code', value: 'abc-100', scope: 'global' }],
    })
    const second = item({
      id: 'two',
      title: 'Example Amazing Video Complete Edition',
      identities: [{ kind: 'content-code', value: 'abc-101', scope: 'global' }],
    })
    expect(matchSimilarItems(first, second)).toBeUndefined()
  })

  it('uses the conservative dice boundary', () => {
    const first = 'example amazing video complete edition'
    const second = 'example amazing video complete editions'
    expect(calculateDiceScore(first, second)).toBeGreaterThanOrEqual(0.92)
    expect(
      matchSimilarItems(item({ title: first }), item({ id: 'two', title: second })),
    ).toMatchObject({ reason: 'title-similar' })
  })

  it('does not group excluded items or different sites', () => {
    expect(
      matchSimilarItems(
        item({ similarityExcluded: true }),
        item({ id: 'two' }),
      ),
    ).toBeUndefined()
    expect(
      matchSimilarItems(item({ siteId: 'one' }), item({ id: 'two', siteId: 'two' })),
    ).toBeUndefined()
    expect(
      matchSimilarItems(
        item({ previewImageUrl: 'https://example.com/no-image.png' }),
        item({ id: 'two' }),
      ),
    ).toBeUndefined()
  })
})
