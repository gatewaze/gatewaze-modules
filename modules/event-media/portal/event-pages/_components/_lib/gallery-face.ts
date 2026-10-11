/**
 * Which picture a tile shows.
 *
 * A photograph in the gallery can be up to three things: the photograph
 * as it was taken, the enhanced copy of it, and -- for the booth -- the
 * selfie somebody actually took before the booth made anything of it.
 * The album decides which is shown by default, and a viewer can switch
 * while looking at one (asked 2026-09-28).
 *
 * X-ray wins over enhanced: a selfie is the thing behind the picture, and
 * there is no enhanced copy of it to choose between.
 */

export interface FaceItem {
  url: string
  variants?: Record<string, string> | null
  /** The photograph the guest took, where the booth kept one. */
  selfie?: string | null
  /** url and variants are the enhanced copy. */
  enhanced?: boolean
  /** The photograph as it was taken, where an enhanced one is shown. */
  original?: { url: string; thumb?: string; medium?: string } | null
  /** The selfie as it was taken, where an enhanced one is being shown. */
  selfieOriginal?: string | null
}

export interface FaceChoice {
  /** Show the selfie behind a booth picture. */
  xray?: boolean
  /** Show the enhanced copy rather than the photograph as it was taken. */
  enhanced?: boolean
}

/** The same object asked for at a width, which the CDN resizes. */
export function sized(url: string, width: number): string {
  return url.includes('?') ? url : `${url}?width=${width}&quality=80`
}

/** Anything under this asks for the thumbnail rather than the preview. */
const SMALL = 400

export function faceOf(item: FaceItem, width: number, choice: FaceChoice = {}): string {
  // A selfie has an enhanced copy of its own -- the booth's room was
  // very dark -- so the same switch applies to it.
  if (choice.xray && item.selfie) {
    const which = choice.enhanced === false && item.selfieOriginal ? item.selfieOriginal : item.selfie
    return sized(which, width)
  }

  const small = width <= SMALL
  if (choice.enhanced === false && item.original) {
    const from = item.original
    return (small ? from.thumb : from.medium) || from.url
  }
  const v = item.variants ?? {}
  return (small ? v['thumb'] : v['medium']) || item.url
}
