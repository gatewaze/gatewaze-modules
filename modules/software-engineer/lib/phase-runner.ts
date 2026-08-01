// @ts-nocheck
/**
 * Shared agent-phase wrapper: clone the worktree, wire the live admin↔agent bridge, run the
 * interactive Agent SDK session, stream se_events + record agent chat, and return the result +
 * repoDir + cleanup. Every repo-touching, model-driven phase (spec/review/implement) uses this;
 * each phase adds only its own pre/post logic (prompt, gating, git commit, enqueue-next).
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeWorkspace, cloneBranch, cloneNewBranch } from './worktree.js';
import { subscribeInput } from './input-channel.js';
import { InProcessRunner } from './agent-session.js';
import { writeEvent, writeMessage, touchRun } from './run-state.js';
import { resolveCommitIdentity } from './credentials.js';
import { recallMemory } from './memory.js';
import { resolveMcpServers, mcpSecretValues } from './mcp.js';
import { redactSecrets } from './git.js';
import { downloadIssueAttachments, ATTACH_DIRNAME } from './attachments.js';
import { githubClient } from './github.js';

/**
 * Multi-repo agent session (§7). The WORKER owns the workspace lifecycle (makeMultiWorkspace +
 * cleanup); this runs the agent in it, injecting every repo's CLAUDE.md/rules (namespaced) + the
 * project memory + a workspace layout that marks which repos are writable. Streams events/messages.
 * spec: { cwd, prompt, allowedTools?, systemAppend?, repos: WsRepo[] }.
 */
export async function runAgentSession(supabase, ctx, run, project, phase, spec) {
  let inputCh;
  try {
    let redis;
    try { redis = ctx?.getRedisConnection?.(); } catch { /* no redis */ }
    inputCh = redis ? subscribeInput(redis, run.id) : null;

    const { count } = await supabase.from('se_events').select('*', { count: 'exact', head: true }).eq('run_id', run.id);
    let seq = count ?? 0;
    // Coarse status markers fill the silent gaps before the model's first token (cloning, context
    // assembly, cold model start) so the Runs tab shows motion the whole time, not just on turns.
    const status = async (text: string, step: string) => {
      try { await writeEvent(supabase, run, phase, seq++, 'status', { text, step }); } catch { /* best-effort */ }
    };
    await status('Gathering repo context and project memory', 'prepare');

    let contracts = '';
    for (const r of spec.repos ?? []) {
      try {
        const claude = await readFile(join(r.dir, 'CLAUDE.md'), 'utf8');
        contracts += `\n\n### Repo \`${r.repoName}\` (${r.writable ? 'WRITABLE' : 'read-only'}) at ./${r.repoName}/\n${claude.slice(0, 16000)}`;
        try {
          const rulesDir = join(r.dir, '.claude', 'rules');
          for (const f of (await readdir(rulesDir)).filter((n) => n.endsWith('.md'))) {
            contracts += `\n\n#### ${r.repoName}/.claude/rules/${f}\n` + (await readFile(join(rulesDir, f), 'utf8')).slice(0, 8000);
          }
        } catch { /* no rules */ }
      } catch { /* no CLAUDE.md */ }
    }
    let memory = '';
    try { memory = await recallMemory(run.project_id); } catch { /* soft */ }

    // Reporter attachments (screenshots) → the agent's eyes. Best-effort: fetch the issue body and
    // download its images into the workspace so the agent can Read them (rendered visually, like a
    // pasted image in a Claude Code session). Skipped silently when there are none. Disable with
    // spec.attachments === false.
    let attachNote = '';
    if (spec.attachments !== false) {
      try {
        const issue = await githubClient(project.githubToken).getIssue(run.repo_owner, run.repo_name, run.issue_number);
        const dl = await downloadIssueAttachments(String(issue?.body ?? ''), project.githubToken, spec.cwd);
        if (dl.count > 0) {
          attachNote =
            `\n--- REPORTER ATTACHMENTS ---\nThe person who filed this issue attached ${dl.count} screenshot(s), saved in ./${ATTACH_DIRNAME}/ (${dl.names.join(', ')}). ` +
            `Use the Read tool on each BEFORE you start — they are visual context (bug screenshots, mockups) for this task.`;
        }
      } catch { /* no attachments / offline — soft */ }
    }

    const layout = (spec.repos ?? []).map((r) => `- ./${r.repoName}/  (${r.writable ? 'WRITABLE — you may change this' : 'read-only — context only'})`).join('\n');
    const systemAppend =
      (spec.systemAppend ? spec.systemAppend + '\n\n' : '') +
      `--- WORKSPACE ---\nYou are in a multi-repo workspace; each repository is a subdirectory:\n${layout}\nMake code changes ONLY in WRITABLE repos; read any repo for context.\n` +
      attachNote +
      (contracts ? `\n--- REPO WORKING AGREEMENTS (follow each repo's own exactly) ---${contracts}\n` : '') +
      (memory ? `\n--- PROJECT MEMORY (what past runs learned; trust, but verify against current code) ---\n${memory.slice(0, 16000)}` : '');

    // §10: connected tools (Gatewaze default + per-project Jira/Slack). Soft: {} when unconfigured.
    let mcpServers = {};
    try { mcpServers = resolveMcpServers(project); } catch { /* no tools */ }

    await status(`Starting the agent (${phase})`, 'start');
    // Heartbeat: while the agent works, bump se_runs.updated_at every 20s so a live-but-quiet run stays
    // distinguishable from a wedged one in the Runs tab. Cleared in finally so the interval never leaks.
    const heartbeat = setInterval(() => { touchRun(supabase, run).catch(() => {}); }, 20000);
    const runner = new InProcessRunner();
    let result;
    try {
      result = await runner.runPhase({
        cwd: spec.cwd,
        prompt: spec.prompt,
        model: project.model,
        credential: { kind: project.modelCredKind, value: project.modelCred },
        allowedTools: spec.allowedTools,
        systemAppend,
        mcpServers,
        inputSource: inputCh ? inputCh[Symbol.asyncIterator]() : undefined,
        onEvent: async (ev) => { try { await writeEvent(supabase, run, phase, seq++, ev.kind, ev.payload); } catch { /* best-effort */ } },
        onAgentMessage: async (t) => { try { await writeMessage(supabase, run, 'agent', t, { subSessionId: phase }); } catch { /* best-effort */ } },
      });
    } finally {
      clearInterval(heartbeat);
    }
    try { inputCh?.close?.(); } catch { /* ignore */ }
    // Scrub EVERY run secret from the SDK's raw stderr before it reaches se_phases/se_runs/UI — the
    // GitHub PAT, the model credential, and any MCP bearer token (not just the PAT). Belt-and-braces
    // with the per-worker redactToken calls.
    if (result?.error) {
      try { result.error = redactSecrets(result.error, [project.githubToken, project.modelCred, ...mcpSecretValues(mcpServers)]); } catch { /* best-effort */ }
    }
    return result;
  } catch (e) {
    try { inputCh?.close?.(); } catch { /* ignore */ }
    throw e;
  }
}

export async function runAgentPhase(supabase, ctx, run, settings, phase, spec) {
  // spec: { branch?, createBranch?: {from,name}, prompt, allowedTools?, systemAppend? }
  const token = settings.githubToken;
  const ws = await makeWorkspace();
  let inputCh;
  try {
    // Commits are authored as the PAT owner (derived from the token) so the PR reads as their own
    // local work; the engineer is named only in a quiet commit trailer (see worktree.commitTrailers).
    const commitId = await resolveCommitIdentity(supabase, settings, token);
    if (spec.createBranch) {
      await cloneNewBranch(ws.repoDir, run, token, spec.createBranch.from, spec.createBranch.name, commitId);
    } else {
      await cloneBranch(ws.repoDir, run, token, spec.branch, commitId);
    }

    let redis;
    try { redis = ctx?.getRedisConnection?.(); } catch { /* no redis → no live steering */ }
    inputCh = redis ? subscribeInput(redis, run.id) : null;

    // Continue the run's event sequence so lanes interleave correctly in the UI.
    const { count } = await supabase.from('se_events').select('*', { count: 'exact', head: true }).eq('run_id', run.id);
    let seq = count ?? 0;
    const status = async (text: string, step: string) => {
      try { await writeEvent(supabase, run, phase, seq++, 'status', { text, step }); } catch { /* best-effort */ }
    };
    await status('Repository ready — gathering context', 'prepare');

    // Inject the repo's agent contract (CLAUDE.md + .claude/rules) into the system prompt — the SDK
    // can't load them via settingSources without also loading the repo's plugin marketplace, which
    // aborts in the runner container (agent-session §5.1 fallback).
    let contract = '';
    try {
      contract = await readFile(join(ws.repoDir, 'CLAUDE.md'), 'utf8');
      try {
        const rulesDir = join(ws.repoDir, '.claude', 'rules');
        for (const f of (await readdir(rulesDir)).filter((n) => n.endsWith('.md'))) {
          contract += `\n\n# .claude/rules/${f}\n` + (await readFile(join(rulesDir, f), 'utf8'));
        }
      } catch { /* no rules dir */ }
    } catch { /* no CLAUDE.md */ }
    // Recall the PROJECT's memory (what past runs across its repos learned) — shared, durable,
    // injected so every run starts warm. Best-effort: '' when the wiki isn't available.
    let memory = '';
    try { memory = await recallMemory(run.project_id); } catch { /* soft */ }

    const systemAppend =
      (spec.systemAppend ? spec.systemAppend + '\n\n' : '') +
      (contract ? `--- THIS REPOSITORY'S WORKING AGREEMENT — follow it exactly ---\n${contract.slice(0, 40000)}\n\n` : '') +
      (memory ? `--- PROJECT MEMORY (what past runs learned about this project's repos — trust, but verify against current code) ---\n${memory.slice(0, 16000)}` : '');

    await status(`Starting the agent (${phase})`, 'start');
    const heartbeat = setInterval(() => { touchRun(supabase, run).catch(() => {}); }, 20000);
    const runner = new InProcessRunner();
    let result;
    try {
      result = await runner.runPhase({
        cwd: ws.repoDir,
        prompt: spec.prompt,
        model: settings.model,
        credential: { kind: settings.modelCredKind, value: settings.modelCred },
        allowedTools: spec.allowedTools,
        systemAppend,
        inputSource: inputCh ? inputCh[Symbol.asyncIterator]() : undefined,
        onEvent: async (ev) => { try { await writeEvent(supabase, run, phase, seq++, ev.kind, ev.payload); } catch { /* best-effort */ } },
        onAgentMessage: async (t) => { try { await writeMessage(supabase, run, 'agent', t, { subSessionId: phase }); } catch { /* best-effort */ } },
      });
    } finally {
      clearInterval(heartbeat);
    }

    return {
      result,
      repoDir: ws.repoDir,
      cleanup: async () => { try { inputCh?.close?.(); } catch {}; await ws.cleanup(); },
    };
  } catch (e) {
    try { inputCh?.close?.(); } catch {}
    await ws.cleanup();
    throw e;
  }
}
