'use client'

// Client wrapper so server-component pages can keep the "hide broken image"
// behavior. Server components cannot pass event handlers (e.g. onError) to the
// client, so the onError lives here instead.
import type { ImgHTMLAttributes } from 'react'

export function SafeImg(props: ImgHTMLAttributes<HTMLImageElement>) {
  return (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      {...props}
      onError={(e) => {
        ;(e.target as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}
