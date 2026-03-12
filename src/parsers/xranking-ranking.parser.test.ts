import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { xrankingRankingParser } from './xranking-ranking.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/xranking_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('xrankingRankingParser', () => {
  it('extracts ranking cards into video, status url, and preview image', () => {
    const html = loadFixture()

    const items = xrankingRankingParser(html, 'https://xranking.site/ranking')

    expect(items.length).toBeGreaterThanOrEqual(16)

    const first = items[0]
    expect(first?.title).toContain('1위 -')
    expect(first?.url.startsWith('https://video.twimg.com/')).toBe(true)
    expect(first?.previewImageUrl?.startsWith('https://pbs.twimg.com/')).toBe(true)
    expect(first?.summary?.startsWith('https://x.com/')).toBe(true)
    expect(first?.dedupeKey?.startsWith('xranking:video-')).toBe(true)
    expect(first?.rawHtmlSnippet?.startsWith('조회수 ')).toBe(true)

    const hasInvalidVideoUrl = items.some(
      (item) => !item.url.startsWith('https://video.twimg.com/'),
    )
    const hasMissingPreview = items.some(
      (item) => !item.previewImageUrl?.startsWith('https://pbs.twimg.com/'),
    )
    const hasMissingStatus = items.some(
      (item) => !item.summary || !item.summary.startsWith('https://x.com/'),
    )
    const hasMalformedTitle = items.some((item) => !/^\d+위 - .+/.test(item.title))

    expect(hasInvalidVideoUrl).toBe(false)
    expect(hasMissingPreview).toBe(false)
    expect(hasMissingStatus).toBe(false)
    expect(hasMalformedTitle).toBe(false)

    const duplicatedStatusItems = items.filter(
      (item) => item.summary === 'https://x.com/i/status/2028064120235516288',
    )
    const duplicatedStatusVideoCount = new Set(duplicatedStatusItems.map((item) => item.url))
      .size

    expect(duplicatedStatusItems.length).toBeGreaterThan(1)
    expect(duplicatedStatusVideoCount).toBe(duplicatedStatusItems.length)
  })

  it('keeps separate items when status url is duplicated but video ids differ', () => {
    const html = `
      <article>
        <div class="absolute top-3 left-3">1</div>
        <video src="https://video.twimg.com/amplify_video/111/vid/avc1/a.mp4?tag=14" poster="https://pbs.twimg.com/amplify_video_thumb/111/img/a.jpg?name=orig"></video>
        <a href="https://x.com/i/status/500" class="block">first card</a>
        <div class="lucide-eye"></div><span>99</span>
      </article>
      <article>
        <div class="absolute top-3 left-3">2</div>
        <video src="https://video.twimg.com/amplify_video/222/vid/avc1/b.mp4?tag=14" poster="https://pbs.twimg.com/amplify_video_thumb/222/img/b.jpg?name=orig"></video>
        <a href="https://x.com/i/status/500?s=20" class="block">second card</a>
        <div class="lucide-eye"></div><span>88</span>
      </article>
    `

    const items = xrankingRankingParser(html, 'https://xranking.site/ranking')

    expect(items).toHaveLength(2)
    expect(items[0]?.title.startsWith('1위 -')).toBe(true)
    expect(items[1]?.title.startsWith('2위 -')).toBe(true)
    expect(items[0]?.summary).toBe('https://x.com/i/status/500')
    expect(items[1]?.summary).toBe('https://x.com/i/status/500')

    const dedupeKeys = new Set(items.map((item) => item.dedupeKey))
    expect(dedupeKeys.size).toBe(2)
  })

  it('dedupes duplicate video ids and keeps the higher rank item', () => {
    const html = `
      <article>
        <div class="absolute top-3 left-3">5</div>
        <video src="https://video.twimg.com/amplify_video/333/vid/avc1/first.mp4?tag=14" poster="https://pbs.twimg.com/amplify_video_thumb/333/img/first.jpg?name=orig"></video>
        <a href="https://x.com/i/status/700" class="block">low rank copy</a>
      </article>
      <article>
        <div class="absolute top-3 left-3">1</div>
        <video src="https://video.twimg.com/ext_tw_video/333/pu/vid/avc1/better.mp4?tag=21" poster="https://pbs.twimg.com/ext_tw_video_thumb/333/pu/img/better.jpg?name=orig"></video>
        <a href="https://x.com/i/status/701?s=19" class="block">high rank copy</a>
      </article>
    `

    const items = xrankingRankingParser(html, 'https://xranking.site/ranking')

    expect(items).toHaveLength(1)
    expect(items[0]?.title.startsWith('1위 -')).toBe(true)
    expect(items[0]?.summary).toBe('https://x.com/i/status/701')
    expect(items[0]?.dedupeKey).toBe('xranking:video-id:333')
  })
})
