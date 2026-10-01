export interface AutoCrawlProgress {
  page: number
  completedPages: number
  insertedCount: number
  duplicateCount: number
  rejectedCount: number
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export async function waitForSnapshot<T>(request: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort = () => {}
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      timer = setTimeout(() => reject(new Error('페이지 문서 응답 시간이 초과되었습니다. 사이트 화면을 확인해주세요.')), Math.max(1, timeoutMs))
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
