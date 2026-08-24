import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ydkoreaPopularBestParser } from './ydkorea-popular-best.parser'

const fixturePath = new URL(
  '../test/fixtures/parsers/ydkorea_popular.html',
  import.meta.url,
)
const pageUrl = 'https://yadongkorea02.tv/popular?vType=best&bo_table=korea'

describe('ydkoreaPopularBestParser', () => {
  it('extracts video cards with canonical links, titles, and previews', () => {
    const items = ydkoreaPopularBestParser(readFileSync(fixturePath, 'utf-8'), pageUrl)

    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({
      title: '첫 번째 샘플 & 특별편',
      url: 'https://yadongkorea02.tv/video/SampleVideoId01',
      previewImageUrl:
        'https://k.vdnext.com/cast2/sample-01/thumbnail.jpg?v=origin',
      dedupeKey: 'ydkorea:video:SampleVideoId01',
      identities: [
        { kind: 'source-id', value: 'SampleVideoId01', scope: 'site' },
        {
          kind: 'canonical-url',
          value: '/video/samplevideoid01',
          scope: 'site',
        },
      ],
    })
    expect(items[1]).toMatchObject({
      title: '두 번째 샘플',
      url: 'https://yadongkorea02.tv/video/SampleVideoId02',
      previewImageUrl: 'https://yadongkorea02.tv/images/sample-02.jpg',
      dedupeKey: 'ydkorea:video:SampleVideoId02',
    })
    expect(items[2]).toMatchObject({
      title: '앵커 대체 경로',
      url: 'https://yadongkorea02.tv/video/SampleVideoId03',
      dedupeKey: 'ydkorea:video:SampleVideoId03',
    })
  })

  it('keeps the video identity stable when the source domain changes', () => {
    const html = `
      <li onclick="location.href='/video/StableVideoId';">
        <div class="thumb"><img src="/thumbnail.jpg"></div>
        <div class="title">Stable item</div>
      </li>
    `

    const first = ydkoreaPopularBestParser(html, pageUrl)[0]
    const second = ydkoreaPopularBestParser(
      html,
      'https://yadongkorea03.tv/popular?vType=best&bo_table=korea',
    )[0]

    expect(first?.dedupeKey).toBe('ydkorea:video:StableVideoId')
    expect(second?.dedupeKey).toBe(first?.dedupeKey)
    expect(second?.url).toBe('https://yadongkorea03.tv/video/StableVideoId')
  })
})
