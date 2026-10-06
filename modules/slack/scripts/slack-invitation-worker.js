import fs from 'fs';
import path from 'path';
import { SlackInvitationManager } from './SlackInvitationManager.js';

// Injected by caller (job-worker.js)
let supabase = null;

/**
 * Materialise the captured Slack session (cookie file) from the environment.
 *
 * On k8s the worker's filesystem is ephemeral and the chart has no file-mount
 * hook, so the session travels as a base64 env var (SLACK_SESSION_SECRET_B64,
 * sops-encrypted at rest in the brand values) and is written to
 * SLACK_SESSION_PATH on first use. An existing file is never overwritten: the
 * manager re-saves refreshed cookies there after each run, and those must win
 * for the life of the pod. Returns true when a file was written.
 */
export function seedSessionFromEnv(env = process.env) {
  const b64 = env.SLACK_SESSION_SECRET_B64;
  const target = env.SLACK_SESSION_PATH;
  if (!b64 || !target) return false;
  if (fs.existsSync(target)) return false;

  let raw;
  try {
    raw = Buffer.from(b64, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.cookies) || typeof parsed.workspaceUrl !== 'string') {
      throw new Error('missing cookies[] or workspaceUrl');
    }
  } catch {
    // Static message on purpose: JSON.parse errors echo a slice of the input,
    // which here is cookie material.
    console.error('❌ SLACK_SESSION_SECRET_B64 is not a valid session file (expected JSON with workspaceUrl and cookies[]); not seeding');
    return false;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // 'wx' refuses to clobber a file that appeared since the existence check.
  fs.writeFileSync(target, raw, { mode: 0o600, flag: 'wx' });
  console.log(`🔑 Seeded Slack session file from SLACK_SESSION_SECRET_B64 -> ${target}`);
  return true;
}

/**
 * Initialize the worker with external dependencies.
 */
export function initSlackWorker({ supabase: sb }) {
  supabase = sb;
}

function getSupabase() {
  if (!supabase) throw new Error('Slack worker not initialized — call initSlackWorker() first');
  return supabase;
}

/**
 * Build the browser worker's egress proxy URL from the residential-egress module
 * config (single source of truth for the provider credentials), falling back to
 * the SLACK_PROXY_URL env var. Returns null when no proxy is configured.
 */
async function resolveProxyUrl(sb) {
  try {
    const { data } = await sb.from('installed_modules').select('config').eq('id', 'residential-egress').maybeSingle();
    const c = data && data.config;
    if (c && c.provider === 'dataimpulse' && c.proxy_username && c.proxy_password) {
      // US-pinned sticky session keeps the send IP consistent with the captured session.
      const user = encodeURIComponent(`${c.proxy_username}__cr.us__sid.aaifslack1`);
      const pass = encodeURIComponent(c.proxy_password);
      return `http://${user}:${pass}@gw.dataimpulse.com:823`;
    }
  } catch (e) {
    console.warn('⚠️  Could not read residential-egress config for proxy:', e.message);
  }
  return process.env.SLACK_PROXY_URL || null;
}

// Worker state
let isProcessingQueue = false;
let invitationManager = null;

/**
 * Process the Slack invitation queue
 * Continuously processes pending invitations until queue is empty
 */
export async function processQueue() {
  // Prevent multiple processors from running
  if (isProcessingQueue) {
    console.log('⚠️  Queue processor already running');
    return;
  }

  isProcessingQueue = true;
  console.log('🚀 Starting Slack invitation queue processor...');

  try {
    // Initialize invitation manager once
    seedSessionFromEnv();
    const proxyUrl = await resolveProxyUrl(getSupabase());
    if (proxyUrl) console.log('🌐 Slack worker egress via residential proxy');
    invitationManager = new SlackInvitationManager({
      workspaceUrl: process.env.SLACK_WORKSPACE_URL,
      adminEmail: process.env.SLACK_ADMIN_EMAIL,
      adminPassword: process.env.SLACK_ADMIN_PASSWORD,
      headless: true,
      proxyUrl,
      // Session cookie file location — mount the captured session as a Secret at
      // a stable path and point SLACK_SESSION_PATH at it (else the manager's
      // in-module default, which apply-update can rebuild).
      sessionFilePath: process.env.SLACK_SESSION_PATH || undefined,
    });

    await invitationManager.initialize();

    // Ensure we're authenticated before starting
    await invitationManager.ensureAuthenticated();

    let processedCount = 0;

    while (true) {
      // Get next pending invitation
      const { data, error } = await getSupabase()
        .rpc('integrations_get_pending_slack_invitations', { limit_count: 1 });

      if (error) {
        console.error('❌ Error getting next invitation:', error);
        break;
      }

      // If no pending invitations, stop processing
      if (!data || data.length === 0) {
        console.log('📋 Queue empty - processor stopping');
        console.log(`✅ Processed ${processedCount} invitations`);
        break;
      }

      const invitation = data[0];
      console.log(`\n📋 Processing invitation ${processedCount + 1} for ${invitation.email} (ID: ${invitation.id})`);

      // Mark as processing
      await updateInvitationStatus(invitation.id, 'processing');

      try {
        // Send the invitation
        const result = await invitationManager.inviteUser(invitation.email);

        if (result.success) {
          // Mark as completed
          await updateInvitationStatus(invitation.id, 'completed', null);
          console.log(`✅ Completed invitation for ${invitation.email}`);
          processedCount++;
        } else if (result.alreadyInvited) {
          // Mark as completed (already invited counts as success)
          await updateInvitationStatus(invitation.id, 'completed', 'User already invited or is a member');
          console.log(`✅ User ${invitation.email} already invited/member`);
          processedCount++;
        } else {
          // Mark as failed
          await updateInvitationStatus(invitation.id, 'failed', result.message);
          console.error(`❌ Failed invitation for ${invitation.email}: ${result.message}`);
        }
      } catch (error) {
        // Mark as failed
        await updateInvitationStatus(invitation.id, 'failed', error.message);
        console.error(`❌ Exception during invitation for ${invitation.email}:`, error.message);
      }

      // Wait 5 seconds between invitations to allow Slack UI to stabilize
      if (data.length > 0) {
        console.log('⏱️  Waiting 5 seconds before next invitation...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

  } catch (error) {
    console.error('❌ Fatal error in queue processor:', error);
  } finally {
    // Cleanup
    if (invitationManager) {
      await invitationManager.cleanup();
      invitationManager = null;
    }

    isProcessingQueue = false;
    console.log('🛑 Queue processor stopped');
  }
}

/**
 * Update invitation status in database
 */
async function updateInvitationStatus(invitationId, status, errorMessage = null) {
  const { error } = await getSupabase()
    .rpc('integrations_update_slack_invitation_status', {
      p_invitation_id: invitationId,
      p_status: status,
      p_error_message: errorMessage
    });

  if (error) {
    console.error('❌ Error updating invitation status:', error);
  }
}

/**
 * Add an invitation to the queue
 */
export async function addToQueue(email, account = 'default', metadata = {}) {
  const { data, error } = await getSupabase()
    .rpc('integrations_request_slack_invitation', {
      p_email: email,
      p_account: account,
      p_metadata: metadata
    });

  if (error) {
    console.error('❌ Error adding to queue:', error);
    throw error;
  }

  console.log(`✅ Added ${email} to invitation queue (ID: ${data})`);

  // Note: Queue processor runs automatically in the worker pod every 30 seconds
  // No need to trigger it manually here (API pod doesn't have Puppeteer/Chrome)

  return data;
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  const { data, error } = await getSupabase().rpc('integrations_get_slack_invitation_stats');

  if (error) {
    console.error('❌ Error getting queue stats:', error);
    return [];
  }

  return data || [];
}

/**
 * Get pending invitation count
 */
export async function getPendingCount() {
  const { count, error } = await getSupabase()
    .from('integrations_slack_invitation_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (error) {
    console.error('❌ Error getting pending count:', error);
    return 0;
  }

  return count || 0;
}

/**
 * Get invitation status by ID
 */
export async function getInvitationStatus(invitationId) {
  const { data, error } = await getSupabase()
    .from('integrations_slack_invitation_queue')
    .select('*')
    .eq('id', invitationId)
    .single();

  if (error) {
    console.error('❌ Error getting invitation status:', error);
    return null;
  }

  return data;
}

/**
 * Manual trigger for queue processing (for testing/admin use)
 */
export async function triggerQueueProcessor() {
  if (isProcessingQueue) {
    return { success: false, message: 'Queue processor already running' };
  }

  processQueue().catch(err => {
    console.error('❌ Queue processor error:', err);
  });

  return { success: true, message: 'Queue processor started' };
}

// Export worker state for monitoring
export function getWorkerStatus() {
  return {
    isProcessing: isProcessingQueue,
    hasManager: invitationManager !== null
  };
}
