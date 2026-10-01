import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isEmptyNimiApiPayload, nimiTwRankingParser } from './nimi-tw-ranking.parser'

function loadApiFixture(): string {
  const fixturePath = new URL('../test/fixtures/parsers/nimi_ranking_example.json', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

function loadCurrentApiFixture(): string {
  const fixturePath = new URL(
    '../test/fixtures/parsers/nimi_video_api_current.json',
    import.meta.url,
  )
  return readFileSync(fixturePath, 'utf-8')
}

function loadHtmlFixture(): string {
  const fixturePath = new URL('../test/fixtures/parsers/nimi_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('nimiTwRankingParser', () => {
  it('preserves each platform from live API captures and never creates Twitter identities for other platforms', () => {
    const payloads = JSON.parse(readFileSync(new URL('../test/fixtures/parsers/nimi_platform_api.json', import.meta.url), 'utf-8'))
    for (const platform of ['tw', 'ig', 'tt', 'bs']) {
      const payload = payloads[platform]
      const url = `https://video1.nimi.wiki/${platform}/ranking?sort=plays&period=week`
      const items = nimiTwRankingParser(JSON.stringify(payload), url)
      expect(items).toHaveLength(payload.items.length)
      for (const [index, item] of items.entries()) {
        expect(item.sourcePlatform).toBe(platform)
        expect(item.url).toBe(payload.items[index].file_url || payload.items[index].hls_url)
        expect(item.summary).toBe(payload.items[index].posts[0].url)
        expect(item.previewImageUrl).toBe(payload.items[index].thumbnail_url)
        if (platform !== 'tw') {
          expect(item.dedupeKey).toBe(`nimi:${platform}:item:${payload.items[index].id}`)
          expect(item.identities).toEqual([{ kind: 'source-id', scope: 'site', value: item.dedupeKey }])
        }
      }
      if (platform !== 'tw') {
        payload.items[0].video_id = 'provider-id'
        expect(nimiTwRankingParser(JSON.stringify(payload), url)[0]?.dedupeKey).toBe(items[0]?.dedupeKey)
      }
      payload.items[0].platform = platform === 'tw' ? 'ig' : 'tw'
      expect(() => nimiTwRankingParser(JSON.stringify(payload), url)).toThrow('플랫폼')
    }
    expect(isEmptyNimiApiPayload('{"items":[]}')).toBe(true)
    expect(isEmptyNimiApiPayload('{"success":false,"items":[]}')).toBe(false)
    expect(isEmptyNimiApiPayload('{"error":"blocked"}')).toBe(false)
    expect(isEmptyNimiApiPayload('{"error":"blocked","items":[]}')).toBe(false)
    expect(() => nimiTwRankingParser('{"error":"blocked","items":[]}', 'https://video1.nimi.wiki/ig/ranking')).toThrow('응답 형식')
    expect(() => nimiTwRankingParser('{"error":"blocked"}', 'https://video1.nimi.wiki/ig/ranking')).toThrow('응답 형식')
  })
  it('extracts ranked media from the items envelope captured in the failed diagnostic', () => {
    const fixture = readFileSync(
      new URL('../test/fixtures/parsers/nimi_video_api_items.json', import.meta.url),
      'utf-8',
    )
    const items = nimiTwRankingParser(fixture, 'https://video.nimi.wiki/tw/ranking/week')

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: '1위 - Korean Girl Video님의 동영상',
      url: 'https://video.twimg.com/amplify_video/2095443549630386176/vid/avc1/1080x1080/FFMKv9-KMDNBWVM4.mp4?tag=29',
      previewImageUrl:
        'https://pbs.twimg.com/amplify_video_thumb/2095443549630386176/img/Kyw2MTBVbQcMLzmT.jpg?name=orig',
      summary: 'https://x.com/i/status/2095586436263403649',
      dedupeKey: 'nimi:video-id:01a0697d-dba6-78d4-ab4c-b7aea832cb38',
      rawHtmlSnippet: '조회수 33130',
      identities: expect.arrayContaining([
        { kind: 'media-id', value: 'video:2095443549630386176', scope: 'global' },
        { kind: 'media-id', value: 'tweet:2095586436263403649', scope: 'global' },
      ]),
    })
    expect(items[1]?.title).toBe('2위 - 탱덩이님의 동영상')

    const payload = JSON.parse(fixture)
    expect(nimiTwRankingParser(JSON.stringify(payload.items), 'https://video.nimi.wiki/tw/ranking/week'))
      .toEqual(items)
    payload.items.push(payload.items[0])
    expect(nimiTwRankingParser(JSON.stringify(payload), 'https://video.nimi.wiki/tw/ranking/week'))
      .toEqual(items)
  })

  it('accepts an empty items envelope without treating legacy data as current results', () => {
    const payload = JSON.stringify({ items: [], data: JSON.parse(loadCurrentApiFixture()) })
    expect(nimiTwRankingParser(payload, 'https://video.nimi.wiki/tw/ranking/week')).toEqual([])
  })

  it('extracts playable media and canonical posts from the current video API', () => {
    const items = nimiTwRankingParser(
      loadCurrentApiFixture(),
      'https://video.nimi.wiki/tw/ranking/week',
    )

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: '1위 - 민채님의 동영상',
      url: 'https://video.twimg.com/amplify_video/2089699551397687296/vid/avc1/720x1280/fA1JY_y85FR6jybH.mp4?tag=14',
      previewImageUrl:
        'https://pbs.twimg.com/amplify_video_thumb/2089699551397687296/img/IKfqYS4Y-zRMOp9m.jpg?name=orig',
      summary: 'https://x.com/i/status/2089701208718233715',
      dedupeKey: 'nimi:video-id:01a01509-9e6e-7616-8a3b-f97ea6d8b235',
      rawHtmlSnippet: '조회수 29686',
    })
    expect(items.every((item) => item.url.startsWith('https://video.twimg.com/'))).toBe(true)
    expect(items.every((item) => item.summary?.startsWith('https://x.com/'))).toBe(true)
  })

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
    expect(first?.summary).toBe('https://x.com/fancha1111/status/1959105847151534126')
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
    expect(items[0]?.summary).toBe('https://x.com/baji46392/status/2040767780975448378')
    expect(items[0]?.dedupeKey).toBe('nimi:video-id:2040767762675736576')
    expect(items[0]?.rawHtmlSnippet).toBe('조회수 527')
  })

  it('does not store thumbnail-only html cards when api json is unavailable', () => {
    const html = loadHtmlFixture()

    const items = nimiTwRankingParser(html, 'https://tw.nimi.wiki/')

    expect(items).toHaveLength(0)
  })

  it('extracts original tweet links and video links from the current nimi api shape', () => {
    const payload = JSON.stringify([
      {
        id: '2054119491395858432',
        thumbnail_url:
          'https://pbs.twimg.com/amplify_video_thumb/2054119491395858432/img/Uvxu5VE_fXU5BQio.jpg?name=orig',
        direct_url:
          'https://video.twimg.com/amplify_video/2054119491395858432/vid/avc1/1280x720/zkA16ktZJFwEolKg.mp4?tag=14',
        duration: 247,
        posts: [
          {
            id: '2054120219122725174',
            posted_at: '2026-05-24T01:05:00+09:00',
            uploader: {
              handle: 'jiyun_example',
              name: '지윤',
            },
          },
        ],
        play_count: 44600,
      },
    ])

    const items = nimiTwRankingParser(payload, 'https://tw1.nimi.wiki/ko/ranking/week')

    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('1위 - 지윤님의 동영상')
    expect(items[0]?.url).toBe(
      'https://video.twimg.com/amplify_video/2054119491395858432/vid/avc1/1280x720/zkA16ktZJFwEolKg.mp4?tag=14',
    )
    expect(items[0]?.previewImageUrl).toBe(
      'https://pbs.twimg.com/amplify_video_thumb/2054119491395858432/img/Uvxu5VE_fXU5BQio.jpg?name=orig',
    )
    expect(items[0]?.summary).toBe(
      'https://x.com/jiyun_example/status/2054120219122725174',
    )
    expect(items[0]?.dedupeKey).toBe('nimi:video-id:2054119491395858432')
    expect(items[0]?.rawHtmlSnippet).toBe('조회수 44600')
  })

  it('uses the canonical post url and author from the latest nimi api shape', () => {
    const payload = JSON.stringify([
      {
        id: '019fc239-b0fd-7d08-8996-aef9b089b3bb',
        platform: 'tw',
        thumbnail_url:
          'https://pbs.twimg.com/amplify_video_thumb/2083228586283270144/img/SwHHGwXqAK2hxZh4.jpg?name=orig',
        file_url:
          'https://video.twimg.com/amplify_video/2083228586283270144/vid/avc1/606x1080/5vEewIYrpeyae88j.mp4?tag=14',
        hls_url: null,
        duration: 402,
        posts: [
          {
            id: '019fc239-b0fa-7f9e-9236-9227b5a42a4a',
            url: 'https://x.com/i/status/2083228633158881610',
            author: {
              id: '019fc239-b0f8-7841-95a2-c706d3fbb781',
              url: 'https://x.com/_6509076246112',
              handle: '_6509076246112',
              name: '˗ˏˋ 𝐦𝐢𝐮✿',
            },
            posted_at: '2026-07-31T16:29:45Z',
          },
        ],
        created_at: '2026-08-02T11:26:28.60021Z',
        play_count: 40089,
      },
    ])

    const items = nimiTwRankingParser(
      payload,
      'https://tw3.nimi.wiki/ranking/week',
    )

    expect(items).toHaveLength(1)
    expect(items[0]?.title).toBe('1위 - ˗ˏˋ 𝐦𝐢𝐮✿님의 동영상')
    expect(items[0]?.url).toBe(
      'https://video.twimg.com/amplify_video/2083228586283270144/vid/avc1/606x1080/5vEewIYrpeyae88j.mp4?tag=14',
    )
    expect(items[0]?.summary).toBe(
      'https://x.com/i/status/2083228633158881610',
    )
    expect(items[0]?.identities).toEqual(
      expect.arrayContaining([
        {
          kind: 'media-id',
          value: 'video:2083228586283270144',
          scope: 'global',
        },
        {
          kind: 'media-id',
          value: 'tweet:2083228633158881610',
          scope: 'global',
        },
      ]),
    )
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
