import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nimiTwRankingParser } from './nimi-tw-ranking.parser'

function loadApiFixture(): string {
  const fixturePath = new URL('../../public/sample/nimi_ranking_example.json', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

function loadHtmlFixture(): string {
  const fixturePath = new URL('../../public/sample/nimi_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('nimiTwRankingParser', () => {
  it('extracts ranking items from the nimi api payload', () => {
    const items = nimiTwRankingParser(loadApiFixture(), 'https://tw.nimi.wiki/')

    expect(items.length).toBeGreaterThanOrEqual(16)

    const first = items[0]
    expect(first?.title).toBe('1위 - 虎式坦克님의 동영상')
    expect(first?.url).toBe(
      'https://video.twimg.com/amplify_video/1959105747834544128/vid/avc1/720x1176/xhU3Zg83i-snKGbt.mp4?tag=14',
    )
    expect(first?.previewImageUrl).toBe(
      'https://pbs.twimg.com/amplify_video_thumb/1959105747834544128/img/3_Cl2_pnkSbRf3IP.jpg?name=orig',
    )
    expect(first?.summary).toBe('https://x.com/i/status/1959105847151534126')
    expect(first?.dedupeKey).toBe('nimi:video-id:1959105747834544128')
    expect(first?.rawHtmlSnippet).toBe('조회수 7403')

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
  })

  it('extracts ranking items from the current bare-array nimi api payload', () => {
    const payload = JSON.stringify([
      {
        video_id: '2040767762675736576',
        thumbnail_url:
          'https://pbs.twimg.com/ext_tw_video_thumb/2040767762675736576/pu/img/RffKoXzOQWfR9U-R.jpg?name=small',
        direct_url:
          'https://video.twimg.com/ext_tw_video/2040767762675736576/pu/vid/avc1/656x512/6EQLHr05HYGvQUEO.mp4?tag=12',
        duration: 19,
        posts: [
          {
            id: '2040767780975448378',
            posted_at: '2026-04-06T01:47:18+09:00',
            uploader: {
              uid: '1857444376638832640',
              handle: 'baji46392',
              display_name: '오메숍',
              is_partner: false,
            },
          },
        ],
        created_at: '2026-04-06T01:47:18.421259+09:00',
        play_count: 527,
      },
    ])

    const items = nimiTwRankingParser(payload, 'https://tw.nimi.wiki/')

    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('1위 - 오메숍님의 동영상')
    expect(items[0]?.url).toBe(
      'https://video.twimg.com/ext_tw_video/2040767762675736576/pu/vid/avc1/656x512/6EQLHr05HYGvQUEO.mp4?tag=12',
    )
    expect(items[0]?.previewImageUrl).toBe(
      'https://pbs.twimg.com/ext_tw_video_thumb/2040767762675736576/pu/img/RffKoXzOQWfR9U-R.jpg?name=small',
    )
    expect(items[0]?.summary).toBe('https://x.com/i/status/2040767780975448378')
    expect(items[0]?.dedupeKey).toBe('nimi:video-id:2040767762675736576')
    expect(items[0]?.rawHtmlSnippet).toBe('조회수 527')
  })

  it('falls back to parsing hydrated html cards when api json is unavailable', () => {
    const html = loadHtmlFixture()

    const items = nimiTwRankingParser(html, 'https://tw.nimi.wiki/')

    expect(items).toHaveLength(2)
    expect(items[0]?.title).toBe('1위 - Taina Osborn님의 동영상')
    expect(items[0]?.url).toBe(
      'https://pbs.twimg.com/amplify_video_thumb/2031597073586597889/img/ol771CkhT_lhpB1d.jpg?name=orig',
    )
    expect(items[0]?.previewImageUrl).toBe(
      'https://pbs.twimg.com/amplify_video_thumb/2031597073586597889/img/ol771CkhT_lhpB1d.jpg?name=orig',
    )
    expect(items[0]?.summary).toBe('https://x.com/i/status/2031597249218884054')
    expect(items[0]?.dedupeKey).toBe('nimi:preview-id:2031597073586597889')
    expect(items[0]?.rawHtmlSnippet).toBe('조회수 379')
  })

  it('dedupes duplicate video ids and keeps the higher rank item', () => {
    const payload = JSON.stringify({
      success: true,
      data: [
        {
          id: '333',
          title: 'lower rank copy',
          direct_url: 'https://video.twimg.com/amplify_video/333/vid/avc1/720x1280/first.mp4?tag=14',
          thumbnail_url:
            'https://pbs.twimg.com/amplify_video_thumb/333/img/first.jpg?name=orig',
          posts: [{ id: '700' }],
          play_count: 10,
          ranking: 5,
        },
        {
          id: '333',
          title: 'higher rank copy',
          direct_url: 'https://video.twimg.com/ext_tw_video/333/pu/vid/avc1/720x1280/better.mp4?tag=21',
          thumbnail_url:
            'https://pbs.twimg.com/ext_tw_video_thumb/333/pu/img/better.jpg?name=orig',
          posts: [{ id: '701' }],
          play_count: 11,
          ranking: 1,
        },
      ],
    })

    const items = nimiTwRankingParser(payload, 'https://tw.nimi.wiki/')

    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('1위 - higher rank copy')
    expect(items[0]?.summary).toBe('https://x.com/i/status/701')
    expect(items[0]?.dedupeKey).toBe('nimi:video-id:333')
  })
})
