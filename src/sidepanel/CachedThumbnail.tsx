import { useEffect, useRef, useState } from 'react'
import { loadPersistentThumbnail } from './thumbnail-cache'

interface CachedThumbnailProps {
  itemId: string
  sourceUrl: string
  title: string
}

export function CachedThumbnail({
  itemId,
  sourceUrl,
  title,
}: CachedThumbnailProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [loadState, setLoadState] = useState<{ sourceUrl: string; resolvedUrl?: string; failed: boolean }>({
    sourceUrl,
    failed: false,
  })
  const isCurrentSource = loadState.sourceUrl === sourceUrl
  if (!isCurrentSource) setLoadState({ sourceUrl, failed: false })
  const resolvedUrl = isCurrentSource ? loadState.resolvedUrl : undefined
  const failed = isCurrentSource ? loadState.failed : false

  useEffect(() => {
    let disposed = false
    let objectUrl: string | undefined
    let controller: AbortController | undefined
    // Cache fetches must follow visibility too, or hidden rows overload the CDN.
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        controller?.abort()
        controller = undefined
        return
      }
      if (controller) return
      const request = new AbortController()
      controller = request
      void loadPersistentThumbnail(itemId, sourceUrl, request.signal).then((blob) => {
        if (disposed || request.signal.aborted) return
        observer.disconnect()
        if (blob) objectUrl = URL.createObjectURL(blob)
        setLoadState({ sourceUrl, resolvedUrl: objectUrl, failed: !blob })
      }).catch(() => {
        if (!disposed && !request.signal.aborted) {
          observer.disconnect()
          setLoadState({ sourceUrl, failed: true })
        }
      })
    }, { rootMargin: '200px' })
    if (imageRef.current) observer.observe(imageRef.current)

    return () => {
      disposed = true
      observer.disconnect()
      controller?.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [itemId, sourceUrl])

  if (failed) {
    return <div className="item-preview item-preview-empty">미리보기 없음</div>
  }

  return (
    <img
      ref={imageRef}
      src={resolvedUrl}
      alt={title}
      className="item-preview"
      aria-busy={!resolvedUrl}
      referrerPolicy="no-referrer"
      onError={() => {
        if (resolvedUrl !== sourceUrl) {
          setLoadState({ sourceUrl, resolvedUrl: sourceUrl, failed: false })
          return
        }
        setLoadState({ sourceUrl, resolvedUrl: sourceUrl, failed: true })
      }}
    />
  )
}
