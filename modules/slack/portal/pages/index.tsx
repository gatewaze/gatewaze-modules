// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useState } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { getClientBrandConfig } from '@/config/brand'
import { JoinSlackCard } from '../components/JoinSlackCard'
import { parseChannels } from '../components/_lib/joinState'

/**
 * /slack — the community Slack page.
 *
 * Copy comes from the module's public config keys through the anon-readable
 * `integrations_slack_public_info` RPC (workspace name/url, description,
 * highlighted channels). The invitation flow lives in JoinSlackCard.
 */

const DEFAULT_NAME = 'our Slack'

export default function SlackPage() {
  const [info, setInfo] = useState(null) // null = loading
  const brand = getClientBrandConfig()

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const sb = getSupabaseClient()
        const { data, error } = await sb.rpc('integrations_slack_public_info')
        if (!cancelled) setInfo(error ? {} : (data ?? {}))
      } catch {
        if (!cancelled) setInfo({})
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  const workspaceName = (info && info.workspace_name) || DEFAULT_NAME
  const workspaceUrl = (info && typeof info.workspace_url === 'string' && /^https:\/\//.test(info.workspace_url)) ? info.workspace_url : null
  const description = (info && info.description) || 'Ask questions, share what you are building, and meet the people behind the projects.'
  const channels = parseChannels(info ? info.channels : null)

  return (
    <div className="pub-wrap pub-fade">
      <div className="pub-h">
        <h1>Join {workspaceName === DEFAULT_NAME ? 'us on Slack' : `${workspaceName} on Slack`}</h1>
        <p>{description}</p>
      </div>

      <section className="pub-nl">
        <JoinSlackCard
          workspaceName={workspaceName}
          workspaceUrl={workspaceUrl}
          primaryColor={brand && brand.primaryColor}
        />
      </section>

      {channels.length > 0 && (
        <section className="pub-nl">
          <div className="pub-nl-card">
            <h2 className="pub-nl-name">Where to start</h2>
            <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
              {channels.map((c) => (
                <li key={c} style={{ margin: '4px 0' }}>#{c}</li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  )
}
