import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { kissjavMostPopularWeekParser } from './kissjav-most-popular-week.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/kissav_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

function loadNewFixture(): string {
  const fixturePath = new URL('../../public/sample/kissjav_new.html', import.meta.url)
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

  it('extracts items from the updated list-videos item markup', () => {
    const html = loadNewFixture()

    const items = kissjavMostPopularWeekParser(
      html,
      'https://kissjav.com/most-popular/?sort_by=video_viewed_week',
    )

    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({
      title: '새 구조 직접 이미지 샘플 korean porn vip',
      url: 'https://kissjav.com/video/new-card-direct-image/',
      previewImageUrl:
        'https://images.kissjav.com/contents/videos_screenshots/698000/698347/320x180/1.jpg',
    })
    expect(items[1]).toMatchObject({
      title: '새 구조 지연 이미지 샘플 korean porn vip ipcam',
      url: 'https://kissjav.com/video/new-card-lazy-image/',
      previewImageUrl:
        'https://images.kissjav.com/contents/videos_screenshots/701000/701691/320x180/1.jpg',
    })
    expect(items[2]).toMatchObject({
      title: '새 구조 내부 제목 샘플',
      url: 'https://kissjav.com/video/new-card-inner-title/',
      previewImageUrl:
        'https://images.kissjav.com/contents/videos_screenshots/705000/705895/320x180/1.jpg',
    })
  })
})
