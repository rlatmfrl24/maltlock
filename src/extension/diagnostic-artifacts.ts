import type {
  CrawlDiagnosticArtifact,
  CrawlInputSource,
  CrawlWarningCode,
} from '../types/contracts'

export const MAX_DIAGNOSTIC_INPUT_BYTES = 2 * 1024 * 1024
export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const MAX_DIAGNOSTICS_PER_SITE = 3

const textEncoder = new TextEncoder()

export function getInputByteLength(input: string): number {
  return textEncoder.encode(input).byteLength
}

export async function createInputHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input))
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

async function compressText(input: string): Promise<Uint8Array> {
  const compressedStream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))
  const buffer = await new Response(compressedStream).arrayBuffer()
  return new Uint8Array(buffer)
}

export interface CreateDiagnosticArtifactResult {
  artifact?: CrawlDiagnosticArtifact
  warning?: CrawlWarningCode
}

export async function createDiagnosticArtifact(input: {
  runId: string
  siteId: string
  createdAt: number
  inputSource: CrawlInputSource
  content: string
}): Promise<CreateDiagnosticArtifactResult> {
  const originalBytes = getInputByteLength(input.content)
  if (originalBytes > MAX_DIAGNOSTIC_INPUT_BYTES) {
    return { warning: 'PAYLOAD_TOO_LARGE' }
  }

  const payload = await compressText(input.content)
  return {
    artifact: {
      runId: input.runId,
      siteId: input.siteId,
      createdAt: input.createdAt,
      inputSource: input.inputSource,
      mimeType: input.inputSource === 'api-json' ? 'application/json' : 'text/html',
      encoding: 'gzip',
      originalBytes,
      storedBytes: payload.byteLength,
      payload,
    },
  }
}

export async function decompressDiagnosticPayload(
  artifact: CrawlDiagnosticArtifact,
): Promise<string> {
  const stream = new Blob([artifact.payload as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(artifact.encoding))
  return new Response(stream).text()
}
