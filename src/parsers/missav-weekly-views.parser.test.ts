import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { missavWeeklyViewsParser } from './missav-weekly-views.parser'

function loadOldFixture(): string {
  const fixturePath = new URL('../test/fixtures/parsers/missav_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

function loadFixture(): string {
  const fixturePath = new URL('../test/fixtures/parsers/missav_123av.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('missavWeeklyViewsParser', () => {
  it('extracts preview image, url and title from 123AV listing cards', () => {
    const html = loadFixture()

    const items = missavWeeklyViewsParser(html, 'https://123av.com/ko/all?sort=week')

    expect(items.length).toBeGreaterThan(10)

    const first = items[0]
    expect(first?.url).toBe('https://123av.com/ko/v/siro-5689-uncensored-leaked')
    expect(first?.previewImageUrl).toBe(
      'https://icdn.123av.me/img2/s360/b9/siro-5689-uncensored-leaked/cover.jpg?6a31b635',
    )
    expect(first?.dedupeKey).toBe('missav:path:/ko/v/siro-5689-uncensored-leaked')
    expect(first?.title).toContain('SIRO-5689')
    expect(items.every((item) => item.url.startsWith('https://123av.com/ko/v/'))).toBe(true)
  })

  it('ignores the previous MissAV listing structure', () => {
    const html = loadOldFixture()

    const items = missavWeeklyViewsParser(
      html,
      'https://missav123.to/ko/all?sort=weekly_views',
    )

    expect(items).toHaveLength(0)
  })
})
