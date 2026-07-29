import { useEffect, useState } from 'react'
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
  const [loadState, setLoadState] = useState({
    sourceUrl,
    resolvedUrl: sourceUrl,
    failed: false,
  })
  const isCurrentSource = loadState.sourceUrl === sourceUrl
  const resolvedUrl = isCurrentSource ? loadState.resolvedUrl : sourceUrl
  const failed = isCurrentSource ? loadState.failed : false

  useEffect(() => {
    let disposed = false
    let objectUrl: string | undefined

    void loadPersistentThumbnail(itemId, sourceUrl).then((blob) => {
      if (disposed || !blob) return
      objectUrl = URL.createObjectURL(blob)
      setLoadState({ sourceUrl, resolvedUrl: objectUrl, failed: false })
    })

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [itemId, sourceUrl])

  if (failed) {
    return <div className="item-preview item-preview-empty">No Image</div>
  }

  return (
    <img
      src={resolvedUrl}
      alt={title}
      className="item-preview"
      loading="lazy"
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
