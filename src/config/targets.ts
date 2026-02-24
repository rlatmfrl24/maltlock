import type { TargetSite } from '../types/contracts'

export const targetSites: TargetSite[] = [
  {
    id: 'hacker-news',
    name: 'Hacker News',
    url: 'https://news.ycombinator.com/',
    matchPatterns: ['https://news.ycombinator.com/*'],
    parserId: 'hacker-news',
  },
  {
    id: 'devto-latest',
    name: 'DEV.to Latest',
    url: 'https://dev.to/latest',
    matchPatterns: ['https://dev.to/*'],
    parserId: 'devto-latest',
  },
]

export const hostMatchPatterns = Array.from(
  new Set(targetSites.flatMap((site) => site.matchPatterns)),
)

export function getTargetSiteById(siteId: string): TargetSite | undefined {
  return targetSites.find((site) => site.id === siteId)
}

function escapeForRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toPatternRegex(pattern: string): RegExp {
  const escaped = escapeForRegex(pattern).replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export function siteMatchesUrl(site: TargetSite, url: string): boolean {
  return site.matchPatterns.some((pattern) => toPatternRegex(pattern).test(url))
}
