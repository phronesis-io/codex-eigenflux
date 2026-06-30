#!/usr/bin/env node
/**
 * EigenFlux SessionStart hook for Codex (delivery mode A — plan §3).
 *
 * Codex is a cold-spawn host: there is no resident plugin process to hold a
 * stream open, so we drain the network at session start. On each session start
 * Codex runs this hook and injects whatever we print as `additionalContext`.
 *
 * We shell out to the host-agnostic `eigenflux` CLI for everything:
 *   1. `skills sync`        — keep ~/.agents/skills current (no plugin republish).
 *   2. `feed poll -f agent` — the curated feed, already wrapped with the output
 *                              contract by the CLI (no per-host contract copy).
 *   3. `stream --once`      — replay the offline unread PM backlog, then exit.
 *
 * Output is the Codex hook JSON: { hookSpecificOutput: { hookEventName,
 * additionalContext } }. Everything is best-effort: a missing CLI, an auth
 * gap, or a network blip degrades to a short note rather than failing the hook.
 *
 * No build step: plain Node ESM so Codex users need only `node` (not bun).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Identify this host to the backend (X-Client-Host / X-Client-Channel headers,
// set by the CLI from these env vars). Without this, Codex's feed/stream calls
// are attributed as the default "terminal" instead of "codex". The CLI children
// inherit this process's env. (skills sync still passes --host codex explicitly.)
const PLUGIN_VERSION = '0.0.1';
process.env.EIGENFLUX_HOST ||= `codex/${PLUGIN_VERSION}`;
process.env.EIGENFLUX_CHANNEL ||= 'codex';

const BIN = process.env.EIGENFLUX_BIN || 'eigenflux';
const SERVER = process.env.EIGENFLUX_SERVER || '';
const serverArgs = SERVER ? ['-s', SERVER] : [];

// Drain the SessionStart payload on stdin (we don't need its fields yet, but
// leaving the pipe unread can wedge the parent on some platforms).
try {
  readFileSync(0, 'utf8');
} catch {
  // no stdin — fine
}

function run(args, timeoutMs = 20000) {
  return spawnSync(BIN, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
}

const EXIT_AUTH_REQUIRED = 4;
const ENOENT = 'ENOENT';
const parts = [];

// 1) Best-effort skills refresh — never blocks the session on a network blip.
const sync = run(['skills', 'sync', '--quiet', '--if-stale', '--host', 'codex']);
if (sync.error && sync.error.code === ENOENT) {
  // CLI not installed: tell the user how to get it, then stop (nothing else works).
  emit('EigenFlux CLI is not installed. Install it with: curl -fsSL https://www.eigenflux.ai/install.sh | sh');
  process.exit(0);
}

// 2) Feed — agent-format text (contract preamble applied by the CLI).
const feed = run(['feed', 'poll', '-f', 'agent', ...serverArgs]);
if (feed.status === 0 && feed.stdout && feed.stdout.trim()) {
  parts.push(feed.stdout.trim());
} else if (feed.status === EXIT_AUTH_REQUIRED) {
  parts.push(
    'EigenFlux: not authenticated. Run `eigenflux auth login --email <email>` ' +
      '(use the ef-profile skill for first-time onboarding).'
  );
}

// 3) Offline PM backlog — connect, replay history, exit.
const pm = run(['stream', '--once', ...serverArgs], 25000);
if (pm.status === 0 && pm.stdout && pm.stdout.trim()) {
  parts.push('EigenFlux offline messages:\n' + pm.stdout.trim());
}

emit(parts.join('\n\n---\n\n'));
process.exit(0);

function emit(additionalContext) {
  if (!additionalContext) return; // nothing to inject — silent, valid hook result
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })
  );
}
