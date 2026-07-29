import type { ParsedItem } from '../types/contracts'

export type PreviewPolicy = 'all' | 'some' | 'none'
export type DedupeKeyPolicy = 'required' | 'optional'

export interface ParserHealthExpectation {
  exactCount?: number
  minimumCount?: number
  preview: PreviewPolicy
  dedupeKey: DedupeKeyPolicy
}

export interface ParserHealthIssue {
  code:
    | 'COUNT_MISMATCH'
    | 'EMPTY_TITLE'
    | 'INVALID_URL'
    | 'PREVIEW_MISSING'
    | 'DEDUPE_KEY_MISSING'
    | 'DEDUPE_KEY_DUPLICATE'
  detail: string
}

function isHttpUrl(input: string | undefined): boolean {
  if (!input) {
    return false
  }

  try {
    const parsed = new URL(input)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function collectParserHealthIssues(
  items: readonly ParsedItem[],
  expectation: ParserHealthExpectation,
): ParserHealthIssue[] {
  const issues: ParserHealthIssue[] = []

  if (expectation.exactCount !== undefined && items.length !== expectation.exactCount) {
    issues.push({
      code: 'COUNT_MISMATCH',
      detail: `expected ${expectation.exactCount}, received ${items.length}`,
    })
  }

  if (expectation.minimumCount !== undefined && items.length < expectation.minimumCount) {
    issues.push({
      code: 'COUNT_MISMATCH',
      detail: `expected at least ${expectation.minimumCount}, received ${items.length}`,
    })
  }

  if (items.some((item) => !item.title.trim())) {
    issues.push({ code: 'EMPTY_TITLE', detail: 'one or more titles are empty' })
  }

  if (items.some((item) => !isHttpUrl(item.url))) {
    issues.push({ code: 'INVALID_URL', detail: 'one or more item URLs are invalid' })
  }

  const previewCount = items.filter((item) => isHttpUrl(item.previewImageUrl)).length
  if (expectation.preview === 'all' && previewCount !== items.length) {
    issues.push({
      code: 'PREVIEW_MISSING',
      detail: `expected previews for all items, received ${previewCount}/${items.length}`,
    })
  }
  if (expectation.preview === 'some' && items.length > 0 && previewCount === 0) {
    issues.push({ code: 'PREVIEW_MISSING', detail: 'expected at least one preview' })
  }

  if (expectation.dedupeKey === 'required') {
    const keys = items.map((item) => item.dedupeKey?.trim()).filter(Boolean)
    if (keys.length !== items.length) {
      issues.push({
        code: 'DEDUPE_KEY_MISSING',
        detail: `expected dedupe keys for all items, received ${keys.length}/${items.length}`,
      })
    }
    if (new Set(keys).size !== keys.length) {
      issues.push({
        code: 'DEDUPE_KEY_DUPLICATE',
        detail: 'one or more dedupe keys are duplicated',
      })
    }
  }

  return issues
}
