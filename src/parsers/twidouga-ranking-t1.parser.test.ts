import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { twidougaRankingT1Parser } from './twidouga-ranking-t1.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/twdouga_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('twidougaRankingT1Parser', () => {
  it('extracts ranking items with preview image, video url and title', () => {
    const html = loadFixture()

    const items = twidougaRankingT1Parser(
      html,
      'https://www.twidouga.net/ko/ranking_t1.php',
    )

    expect(items.length).toBeGreaterThanOrEqual(10)

    const first = items[0]
    expect(first?.url.startsWith('https://video.twimg.com/')).toBe(true)
    expect(first?.previewImageUrl?.startsWith('https://pbs.twimg.com/')).toBe(true)
    expect(first?.title).toContain('1위')
    expect(first?.summary?.startsWith('https://x.com/')).toBe(true)

    const missingPreview = items.some((item) => !item.previewImageUrl)
    const invalidVideoUrl = items.some(
      (item) => !item.url.startsWith('https://video.twimg.com/'),
    )

    expect(missingPreview).toBe(false)
    expect(invalidVideoUrl).toBe(false)
  })
})
