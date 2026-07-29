import type {
  CrawlDiagnosticArtifact,
  CrawlRun,
} from '../types/contracts'

export interface CrawlDiagnosticExport {
  exportedAt: string
  run: CrawlRun
  artifact?: Omit<CrawlDiagnosticArtifact, 'payload'> & {
    payloadText: string
  }
}

export function createCrawlDiagnosticExport(
  run: CrawlRun,
  artifact: CrawlDiagnosticArtifact | undefined,
  payloadText: string | undefined,
): CrawlDiagnosticExport {
  return {
    exportedAt: new Date().toISOString(),
    run,
    artifact:
      artifact && payloadText !== undefined
        ? {
            runId: artifact.runId,
            siteId: artifact.siteId,
            createdAt: artifact.createdAt,
            inputSource: artifact.inputSource,
            mimeType: artifact.mimeType,
            encoding: artifact.encoding,
            originalBytes: artifact.originalBytes,
            storedBytes: artifact.storedBytes,
            payloadText,
          }
        : undefined,
  }
}
