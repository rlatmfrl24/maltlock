import type { ItemIdentity } from '../types/contracts'
import { extractContentCodes } from '../db/item-similarity'

const TWITTER_MEDIA_REGEX =
  /\/(?:amplify_video|ext_tw_video|amplify_video_thumb|ext_tw_video_thumb)\/(\d+)(?:\/|$)/i
const TWITTER_STATUS_REGEX = /\/status\/(\d+)/i

export function canonicalPathIdentity(
  input: string,
  pageUrl?: string,
): ItemIdentity | undefined {
  try {
    const url = new URL(input, pageUrl)
    url.searchParams.sort()
    const search = url.searchParams.toString()
    return {
      kind: 'canonical-url',
      value: `${url.pathname.toLowerCase()}${search ? `?${search}` : ''}`,
      scope: 'site',
    }
  } catch {
    return undefined
  }
}

export function contentCodeIdentities(...inputs: Array<string | undefined>): ItemIdentity[] {
  const codes = new Set(extractContentCodes(inputs.filter(Boolean).join(' ')))
  return [...codes].map((value) => ({
    kind: 'content-code' as const,
    value,
    scope: 'global' as const,
  }))
}

export function twitterMediaIdentities(
  ...inputs: Array<string | undefined>
): ItemIdentity[] {
  const identities = new Map<string, ItemIdentity>()
  for (const input of inputs) {
    if (!input) continue
    const mediaId = input.match(TWITTER_MEDIA_REGEX)?.[1]
    if (mediaId) {
      identities.set(`video:${mediaId}`, {
        kind: 'media-id',
        value: `video:${mediaId}`,
        scope: 'global',
      })
    }
    const statusId = input.match(TWITTER_STATUS_REGEX)?.[1]
    if (statusId) {
      identities.set(`tweet:${statusId}`, {
        kind: 'media-id',
        value: `tweet:${statusId}`,
        scope: 'global',
      })
    }
  }
  return [...identities.values()]
}

export function sourceIdIdentity(value: string): ItemIdentity {
  return { kind: 'source-id', value, scope: 'site' }
}
