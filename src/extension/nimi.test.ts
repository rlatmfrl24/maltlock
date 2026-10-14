import { describe, expect, it } from 'vitest'
import { buildNimiApiUrl, getNimiActivePeriod, getNimiActiveView, getItemSourcePlatform, getNimiPlatform, getNimiVideoPageUrl, normalizeNimiUrl } from './nimi'
import type { CrawledItem } from '../types/contracts'

describe('nimi helper', () => {
  it.each(['hour', 'day', 'week', 'month', 'year'])('normalizes supported ranking/%s routes without losing filters', (period) => {
    expect(normalizeNimiUrl(`https://video1.nimi.wiki/ig/ranking/${period}?sort=likes&tag=kept#preview`).href)
      .toBe(`https://video1.nimi.wiki/ig/ranking?sort=likes&tag=kept&period=${period}#preview`)
  })

  it('normalizes the supported video host without rewriting unrelated hosts or routes', () => {
    expect(normalizeNimiUrl('https://video.nimi.wiki/tw/ranking/week').href)
      .toBe('https://video1.nimi.wiki/tw/ranking?sort=plays&period=week')
    for (const url of [
      'https://video1.nimi.wiki/tw/new',
      'https://video1.nimi.wiki/tt/ranking?sort=plays&period=day',
      'https://video1.nimi.wiki/tw/ranking/constructor',
      'https://video1.nimi.wiki.evil.test/tw/ranking/week',
      'https://other.test/tw/ranking/week',
    ]) expect(normalizeNimiUrl(url).href).toBe(url)
  })

  it('opens Bluesky previews with the stored Nimi item ID without changing media URLs', () => {
    const id = '01a08f4c-0e9d-7365-8eab-db4bf2112d18'
    const item: CrawledItem = {
      id: 'stored-hash', siteId: 'nimi-tw-ranking', title: 'Video', crawledAt: 1,
      url: 'https://host.bsky.network/xrpc/com.atproto.sync.getBlob?did=test&cid=test',
      dedupeKey: `nimi:bs:item:${id}`,
    }
    expect(getNimiVideoPageUrl(item)).toBe(`https://video1.nimi.wiki/watch/${id}`)
    expect(getNimiVideoPageUrl({ ...item, dedupeKey: undefined, identities: [{ kind: 'source-id', scope: 'site', value: item.dedupeKey! }] })).toBe(`https://video1.nimi.wiki/watch/${id}`)
    expect(getNimiVideoPageUrl({ ...item, summary: undefined, sourcePlatform: 'bs', url: 'https://media.test/video' })).toBe(`https://video1.nimi.wiki/watch/${id}`)
    for (const changed of [
      { siteId: 'other' }, { sourcePlatform: 'tw' as const }, { dedupeKey: `nimi:ig:item:${id}` },
      { dedupeKey: undefined }, { dedupeKey: 'nimi:bs:item:../other' },
      { dedupeKey: undefined, identities: [{ kind: 'source-id' as const, scope: 'global' as const, value: item.dedupeKey! }] },
    ]) expect(getNimiVideoPageUrl({ ...item, ...changed })).toBeUndefined()
  })

  it('resolves all four platform routes and infers legacy sources without trusting lookalike hosts', () => {
    for (const [platform, host] of [['tw', 'video.twimg.com'], ['ig', 'scontent.cdninstagram.com'], ['tt', 'v19.tiktokcdn.com'], ['bs', 'video.bsky.app']] as const) {
      for (const route of ['ranking?sort=plays&period=week', 'ranking?sort=likes', 'new', 'realtime']) {
        expect(buildNimiApiUrl('', `https://video1.nimi.wiki/${platform}/${route}`)).toBe(`https://api.nimi.wiki/video/${platform}/${route}`)
      }
      expect(getItemSourcePlatform({ siteId: 'nimi-tw-ranking', url: `https://${host}/media` })).toBe(platform)
      expect(getItemSourcePlatform({ siteId: 'nimi-tw-ranking', url: `https://${host}.evil.test/media` })).toBeUndefined()
    }
    expect(getNimiPlatform('https://video1.nimi.wiki/unknown/ranking')).toBeUndefined()
    expect(getNimiPlatform('https://video1.nimi.wiki.evil.test/ig/ranking')).toBeUndefined()
    expect(getItemSourcePlatform({ siteId: 'nimi-tw-ranking', url: 'https://unknown.test/media' })).toBeUndefined()
  })
  it('builds the separated video api url from the current Nuxt config', () => {
    const html = `
      <script>
        window.__NUXT__.config={public:{videoApiUrl:"https://api.nimi.wiki/video"}}
      </script>
    `

    expect(
      buildNimiApiUrl(html, 'https://video.nimi.wiki/tw/ranking/week'),
    ).toBe('https://api.nimi.wiki/video/tw/ranking?sort=plays&period=week')
  })

  it('uses the known current api when the runtime config is absent', () => {
    expect(
      buildNimiApiUrl('', 'https://video.nimi.wiki/tw/ranking/day'),
    ).toBe('https://api.nimi.wiki/video/tw/ranking?sort=plays&period=day')
  })

  it('does not accept a video api url outside the NimiWiki domain', () => {
    const html = `
      <script>
        window.__NUXT__.config={public:{videoApiUrl:"https://example.com/video"}}
      </script>
    `

    expect(
      buildNimiApiUrl(html, 'https://video.nimi.wiki/tw/ranking/week'),
    ).toBe('https://api.nimi.wiki/video/tw/ranking?sort=plays&period=week')
  })

  it.each([
    ['ranking?sort=plays&period=week', 'ranking?sort=plays&period=week'],
    ['ranking?sort=likes', 'ranking?sort=likes'],
    ['ranking?sort=plays&period=year', 'ranking?sort=plays&period=year'],
    ['ranking', 'ranking?sort=plays&period=hour'],
    ['new', 'new'],
    ['recent', 'new'],
    ['realtime', 'realtime'],
  ])('uses the current API route for video1 /tw/%s', (route, expected) => {
    expect(buildNimiApiUrl('', `https://video1.nimi.wiki/tw/${route}`))
      .toBe(`https://api.nimi.wiki/video/tw/${expected}`)
  })

  it('uses the diagnostic page config with query-based ranking', () => {
    const html = '<script>window.__NUXT__.config={public:{videoApiUrl:"https://api.nimi.wiki/video"}}</script>'
    expect(buildNimiApiUrl(html, 'https://video1.nimi.wiki/tw/ranking?sort=plays&period=week'))
      .toBe('https://api.nimi.wiki/video/tw/ranking?sort=plays&period=week')
  })

  it('builds the current ranking api url from active tab and period markup', () => {
    const html = `
      <div class="hidden md:flex">
        <a class="tab-active text-white" href="ranking">인기</a>
        <a class="text-violet-200" href="realtime">실시간</a>
        <a class="text-violet-200" href="recent">신규</a>
      </div>
      <div class="inline-flex bg-white/10 rounded-xl p-1">
        <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1시간</button>
        <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all text-violet-200 hover:text-white hover:bg-white/10">1일</button>
      </div>
    `

    expect(getNimiActiveView(html, 'https://tw.nimi.wiki/')).toBe('ranking')
    expect(getNimiActivePeriod(html, 'https://tw.nimi.wiki/')).toBe('hourly')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/')).toBe(
      'https://tw1.nimi.wiki/api/tw/ranking/hour',
    )
  })

  it('uses the active period button text from legacy nimi markup', () => {
    const html = `
      <a class="tab-active text-white" href="ranking">인기</a>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all text-violet-200 hover:text-white hover:bg-white/10">1시간</button>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1주</button>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all text-violet-200 hover:text-white hover:bg-white/10">1달</button>
    `

    expect(getNimiActivePeriod(html, 'https://tw.nimi.wiki/')).toBe('weekly')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/')).toBe(
      'https://tw1.nimi.wiki/api/tw/ranking/week',
    )
  })

  it('uses the current nimi route period segment', () => {
    const html = `
      <button class="tab-active">인기<span>1주</span></button>
      <a href="/ko/realtime">실시간</a>
      <a href="/ko/recent">신규</a>
    `

    expect(getNimiActiveView(html, 'https://tw1.nimi.wiki/ko/ranking/week')).toBe(
      'ranking',
    )
    expect(getNimiActivePeriod(html, 'https://tw1.nimi.wiki/ko/ranking/week')).toBe(
      'weekly',
    )
    expect(buildNimiApiUrl(html, 'https://tw1.nimi.wiki/ko/ranking/week')).toBe(
      'https://tw1.nimi.wiki/api/tw/ranking/week',
    )
  })

  it('uses the tab url to detect realtime and recent pages', () => {
    const html = `
      <a class="tab-active text-white" href="ranking">인기</a>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1시간</button>
    `

    expect(getNimiActiveView(html, 'https://tw.nimi.wiki/realtime')).toBe('realtime')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/realtime')).toBe(
      'https://tw1.nimi.wiki/api/tw/realtime',
    )
    expect(getNimiActiveView(html, 'https://tw.nimi.wiki/recent')).toBe('recent')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/recent')).toBe(
      'https://tw1.nimi.wiki/api/tw/recent',
    )
  })

  it('honors explicit period query params from a custom target url', () => {
    const html = `
      <a class="tab-active text-white" href="ranking">인기</a>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1시간</button>
    `

    expect(getNimiActivePeriod(html, 'https://tw.nimi.wiki/?period=daily')).toBe('daily')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/?period=daily')).toBe(
      'https://tw1.nimi.wiki/api/tw/ranking/day',
    )
  })
})
