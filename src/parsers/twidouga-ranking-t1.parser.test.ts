import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { twidougaRankingT1Parser } from './twidouga-ranking-t1.parser'

function loadFixture(name: string): string {
  const fixturePath = new URL(`../test/fixtures/parsers/${name}`, import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('twidougaRankingT1Parser', () => {
  it('extracts legacy ranking items with preview image, video url and title', () => {
    const html = loadFixture('twdouga_example.html')

    const items = twidougaRankingT1Parser(
      html,
      'https://www.twidouga.net/ko/ranking_t1.php',
    )

    expect(items.length).toBeGreaterThanOrEqual(9)

    const first = items[0]
    expect(first?.url.startsWith('https://video.twimg.com/')).toBe(true)
    expect(first?.previewImageUrl?.startsWith('https://pbs.twimg.com/')).toBe(true)
    expect(first?.title).toContain('1위')
    expect(first?.summary?.startsWith('https://x.com/')).toBe(true)
    expect(first?.dedupeKey?.startsWith('twidouga:video-')).toBe(true)

    const missingPreview = items.some((item) => !item.previewImageUrl)
    const invalidVideoUrl = items.some(
      (item) => !item.url.startsWith('https://video.twimg.com/'),
    )
    const duplicateVideoIdCount = items.filter((item) =>
      item.url.includes('/2025196127910584320/'),
    ).length

    expect(missingPreview).toBe(false)
    expect(invalidVideoUrl).toBe(false)
    expect(duplicateVideoIdCount).toBe(1)
  })

  it('extracts current rank-item data attributes and ignores ad placeholders', () => {
    const html = loadFixture('twidouga_rank_item_data.html')

    const items = twidougaRankingT1Parser(
      html,
      'https://www.twidouga.net/ko/ranking_t1.php',
    )

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: '1위 - https://x.com/i/status/2081692554970693892',
      url: 'https://video.twimg.com/amplify_video/2081692441812606976/vid/avc1/1080x1122/IN7FxRstcAjk-gsV.mp4',
      dedupeKey: 'twidouga:video-id:2081692441812606976',
      previewImageUrl:
        'https://pbs.twimg.com/amplify_video_thumb/2081692441812606976/img/wGzO8zWbglOoYFUU.jpg',
      summary: 'https://x.com/i/status/2081692554970693892',
    })
    expect(items[0]?.identities).toEqual(
      expect.arrayContaining([
        {
          kind: 'media-id',
          value: 'video:2081692441812606976',
          scope: 'global',
        },
        {
          kind: 'media-id',
          value: 'tweet:2081692554970693892',
          scope: 'global',
        },
      ]),
    )
    expect(items[1]).toMatchObject({
      title: '2위 - https://x.com/i/status/2081647555721769374',
      url: 'https://video.twimg.com/amplify_video/2081647051801341953/vid/avc1/1348x720/20O_uqXRw45dvaay.mp4?tag=14&variant=high',
      previewImageUrl:
        'https://pbs.twimg.com/amplify_video_thumb/2081647051801341953/img/zuM4gPIKOSqKZ1qn.jpg',
      summary: 'https://x.com/i/status/2081647555721769374',
    })
  })
})
