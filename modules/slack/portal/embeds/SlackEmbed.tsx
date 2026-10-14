// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { getClientBrandConfig } from '@/config/brand'
import { JoinSlackCard } from '../components/JoinSlackCard'

/**
 * The `embed:slack` portal slot: the "Join our Slack" card for an iframe on
 * another site (`<portal>/embed/slack`). The portal's embed host passes
 * `embedAuth` (popup LFID sign-in, a user-scoped client); the card itself is
 * the same one the /slack page uses.
 *
 * Workspace name and URL come from the anon-readable
 * `integrations_slack_public_info` RPC, as on the page. A plain anon client is
 * used for it: the portal's shared client reads session cookies, which an
 * iframe on another site does not get anyway.
 */

const DEFAULT_NAME = 'our Slack'

export default function SlackEmbed({ embedAuth }) {
  const [info, setInfo] = useState(null)
  const brand = getClientBrandConfig()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const sb = createClient(brand.supabaseUrl, brand.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
        const { data, error } = await sb.rpc('integrations_slack_public_info')
        if (!cancelled) setInfo(error ? {} : (data ?? {}))
      } catch {
        if (!cancelled) setInfo({})
      }
    })()
    return () => { cancelled = true }
  }, [brand.supabaseUrl, brand.supabaseAnonKey])

  const workspaceName = (info && info.workspace_name) || DEFAULT_NAME
  const workspaceUrl = (info && typeof info.workspace_url === 'string' && /^https:\/\//.test(info.workspace_url)) ? info.workspace_url : null

  return (
    <div className="pub-nl" style={{ margin: 0 }}>
      <JoinSlackCard
        workspaceName={workspaceName}
        workspaceUrl={workspaceUrl}
        primaryColor={brand && brand.primaryColor}
        embedAuth={embedAuth}
      />
    </div>
  )
}
