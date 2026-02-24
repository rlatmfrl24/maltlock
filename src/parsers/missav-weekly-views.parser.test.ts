import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { missavWeeklyViewsParser } from './missav-weekly-views.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/missav_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('missavWeeklyViewsParser', () => {
  it('extracts preview image, url and title from listing cards', () => {
    const html = loadFixture()

    const items = missavWeeklyViewsParser(
      html,
      'https://missav123.to/ko/all?sort=weekly_views',
    )

    expect(items.length).toBeGreaterThan(10)

    const first = items[0]
    expect(first?.url).toBe('https://missav123.to/ko/v/adn-757-uncensored-leaked')
    expect(first?.previewImageUrl).toBe(
      'https://icdn.missav123.to/img2/s360/d4/adn-757-uncensored-leaked/cover.webp',
    )
    expect(first?.title).toContain('ADN-757')
  })
})
