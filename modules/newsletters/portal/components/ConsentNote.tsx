// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useState } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'

/**
 * Marketing-consent note under the newsletter signup field. The text is
 * per-brand configured (admin → Settings → Branding → Portal → Legal,
 * platform_settings.newsletter_consent_html — HTML so it can carry the
 * Privacy Policy link). Brands that configure nothing render nothing.
 */
export function ConsentNote() {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = getSupabaseClient()
        const { data } = await sb
          .from('platform_settings')
          .select('value')
          .eq('key', 'newsletter_consent_html')
          .maybeSingle()
        if (!cancelled && data?.value && data.value.trim()) setHtml(data.value.trim())
      } catch {
        /* unconfigured / unreachable → render nothing */
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (!html) return null
  return (
    <p
      className="pub-nl-consent"
      style={{ color: 'var(--ink-3)', fontSize: 12, lineHeight: 1.55, marginTop: 10, maxWidth: '52ch' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default ConsentNote
