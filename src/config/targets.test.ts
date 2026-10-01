import { describe, expect, it } from 'vitest'
import { getTargetSiteById, hostMatchPatterns, normalizeKissjavUrl, siteMatchesUrl } from './targets'

describe('targetSites', () => {
  it('uses KissJAV li and normalizes the old host without allowing unrelated origins', () => {
    const site = getTargetSiteById('kissjav-most-popular-week')!
    expect(site.url).toBe('https://kissjav.li/most-popular/?sort_by=video_viewed_week')
    expect(hostMatchPatterns).toContain('https://kissjav.li/*')
    expect(hostMatchPatterns).toContain('https://kissjav.com/*')
    expect(siteMatchesUrl(site, site.url, 'https://kissjav.com/most-popular/?sort_by=video_viewed_week')).toBe(true)
    expect(normalizeKissjavUrl('https://kissjav.com/most-popular/2/?sort_by=video_viewed_week').href)
      .toBe('https://kissjav.li/most-popular/2/?sort_by=video_viewed_week')
    for (const input of ['https://kissjav.li.other.test/most-popular/', 'https://other.test/most-popular/', 'http://kissjav.li/most-popular/', 'https://kissjav.li:8443/most-popular/']) {
      expect(() => normalizeKissjavUrl(input)).toThrow('지원하지 않는 KissJAV 주소')
    }
  })

  it('uses the current NimiWiki host and retains legacy host compatibility', () => {
    const site = getTargetSiteById('nimi-tw-ranking')

    expect(site?.url).toBe('https://video1.nimi.wiki/tw/ranking?sort=plays&period=week')
    expect(site && siteMatchesUrl(site, 'https://video1.nimi.wiki/tw/ranking?sort=plays&period=week'))
      .toBe(true)
    expect(hostMatchPatterns).toContain('https://video1.nimi.wiki/*')
    expect(
      site && siteMatchesUrl(site, 'https://video.nimi.wiki/tw/ranking/week'),
    ).toBe(true)
    expect(
      site && siteMatchesUrl(site, 'https://tw2.nimi.wiki/ranking/week'),
    ).toBe(true)
  })

  it('keeps ydkorea collection disabled', () => {
    expect(getTargetSiteById('ydkorea-popular-best')).toBeUndefined()
    expect(hostMatchPatterns).not.toContain('https://yadongkorea02.tv/*')
  })
})
