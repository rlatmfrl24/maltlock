import type {
  CrawlErrorCode,
  CrawlRun,
  CrawlStage,
} from '../types/contracts'

const MAX_ERROR_DETAIL_LENGTH = 2_048
const PARSER_FAILURE_CODES = new Set<CrawlErrorCode>([
  'PARSE_EMPTY',
  'PARSE_FAILED',
  'NORMALIZATION_EMPTY',
])

export interface CrawlOutcomeInput {
  parsedCount: number
  validCount: number
  rejectedCount: number
}

export interface CrawlOutcome {
  status: CrawlRun['status']
  errorCode?: CrawlErrorCode
}

export function classifyCrawlOutcome(input: CrawlOutcomeInput): CrawlOutcome {
  if (input.parsedCount === 0) {
    return { status: 'failed', errorCode: 'PARSE_EMPTY' }
  }

  if (input.validCount === 0) {
    return { status: 'failed', errorCode: 'NORMALIZATION_EMPTY' }
  }

  if (input.rejectedCount > 0) {
    return { status: 'partial' }
  }

  return { status: 'success' }
}

export function clipErrorDetail(detail: string | undefined): string | undefined {
  const trimmed = detail?.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed.slice(0, MAX_ERROR_DETAIL_LENGTH)
}

export function isParserFailureRun(run: CrawlRun): boolean {
  return Boolean(
    run.parsedCount !== undefined &&
      run.errorCode &&
      PARSER_FAILURE_CODES.has(run.errorCode),
  )
}

export function hasConsecutiveParserFailures(
  runs: readonly CrawlRun[],
  requiredCount = 2,
): boolean {
  if (requiredCount <= 0) {
    return true
  }

  let failureCount = 0
  for (const run of runs) {
    if (run.parsedCount === undefined) {
      continue
    }

    if (isParserFailureRun(run)) {
      failureCount += 1
      if (failureCount >= requiredCount) {
        return true
      }
      continue
    }

    if (run.status === 'success' || run.status === 'partial') {
      return false
    }
  }

  return false
}

export function setCrawlStage(run: CrawlRun, stage: CrawlStage): void {
  run.stage = stage
}
