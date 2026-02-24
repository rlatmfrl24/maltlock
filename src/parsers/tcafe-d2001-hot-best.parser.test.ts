import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tcafeD2001HotBestParser } from './tcafe-d2001-hot-best.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/tcafe_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('tcafeD2001HotBestParser', () => {
  it('extracts only daily/weekly best posts from the hot section', () => {
    const html = loadFixture()

    const items = tcafeD2001HotBestParser(
      html,
      'https://tcafe21.com/bbs/board.php?bo_table=D2001',
    )

    expect(items).toHaveLength(10)

    expect(items[0]).toMatchObject({
      title: '이쁜 최근자 노예녀 1.91GB',
      url: 'https://tcafe21.com/bbs/board.php?bo_table=D2001&wr_id=32140',
      summary: '일간 베스트 · 댓글 +9',
    })

    expect(items[5]).toMatchObject({
      title: '국산몰카 백만원짜리 조건 란제리모델과 모텔에서 1.41gb',
      url: 'https://tcafe21.com/bbs/board.php?bo_table=D2001&wr_id=27369',
      summary: '주간 베스트 · 댓글 +23',
    })

    const nonBestItem = items.some((item) => item.url.includes('wr_id=33125'))
    expect(nonBestItem).toBe(false)
  })
})
