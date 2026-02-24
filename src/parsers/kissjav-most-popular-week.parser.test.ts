import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { kissjavMostPopularWeekParser } from './kissjav-most-popular-week.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/kissav_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('kissjavMostPopularWeekParser', () => {
  it('extracts title, url, and preview image from video cards', () => {
    const html = loadFixture()

    const items = kissjavMostPopularWeekParser(
      html,
      'https://kissjav.com/most-popular/?sort_by=video_viewed_week',
    )

    expect(items.length).toBeGreaterThan(10)
    expect(items[0]).toMatchObject({
      title: '입싸받아주는 예쁘고 어린 여친 korean porn vip',
      url: 'https://kissjav.com/video/480795/korean-porn-vip2155/',
      previewImageUrl:
        'https://kissjav.com/contents/videos_screenshots/480000/480795/320x180/1.jpg',
    })

    const hasMissingPreview = items.some((item) => !item.previewImageUrl)
    expect(hasMissingPreview).toBe(false)
  })
})
