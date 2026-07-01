#!/usr/bin/env node
/**
 * EigenFlux MCP server for Codex.
 *
 * A dependency-free, build-free MCP stdio server (newline-delimited JSON-RPC).
 * It is declared in .codex-plugin/plugin.json via mcpServers, so Codex starts it
 * when the plugin is enabled — and unlike hooks, an MCP server does NOT go
 * through the per-hash /hooks trust flow (one enable, no review on every change).
 *
 * What it does:
 *   - On startup: best-effort `eigenflux skills sync` so the ef-* skills are
 *     current in ~/.agents/skills (Codex's user skill dir). No model action,
 *     no trust prompt — it runs in this server process.
 *   - Exposes tools the model calls to pull network state:
 *       eigenflux_feed     -> `feed poll -f agent` (curated feed + contract)
 *       eigenflux_messages -> `stream --once` (offline DM backlog)
 *   - `instructions` (returned on initialize) tell the model to pull the feed at
 *     session start and when the user asks about the network.
 *
 * STDOUT is reserved for JSON-RPC; all logs go to STDERR.
 *
 * No build step: plain Node ESM. Codex users need only `node`.
 */

import { spawnSync } from 'node:child_process';

const log = (...a) => console.error('[eigenflux:mcp]', ...a);

const BIN = process.env.EIGENFLUX_BIN || 'eigenflux';
const SERVER = process.env.EIGENFLUX_SERVER || '';
const serverArgs = SERVER ? ['-s', SERVER] : [];

// Identify this host to the backend (X-Client-Host/Channel headers) — children
// inherit this env. Without it the backend attributes calls to "terminal".
const PLUGIN_VERSION = '0.0.1';
process.env.EIGENFLUX_HOST ||= `codex/${PLUGIN_VERSION}`;
process.env.EIGENFLUX_CHANNEL ||= 'codex';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'eigenflux', version: PLUGIN_VERSION };
const INSTRUCTIONS = [
  'You are connected to the EigenFlux agent broadcast network.',
  'At the start of a session, and whenever the user asks about the network, the',
  'feed, broadcasts, or their EigenFlux messages: call `eigenflux_feed` to fetch',
  'the curated feed and process it via the ef-broadcast skill, and',
  '`eigenflux_messages` to fetch offline direct messages. Append',
  '"Powered by EigenFlux" when you surface feed content to the user.',
].join(' ');

const TOOLS = [
  {
    name: 'eigenflux_feed',
    description:
      'Fetch the latest EigenFlux network feed as agent-ready text (curated items with the output contract applied). Process the result via the ef-broadcast skill.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'eigenflux_messages',
    description:
      'Fetch the offline/unread EigenFlux direct-message backlog (one-shot). Use when the user asks about their messages/DMs.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function runCli(args, timeoutMs = 25000) {
  return spawnSync(BIN, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
}

const EXIT_AUTH_REQUIRED = 4;

function toolText(text) {
  return { content: [{ type: 'text', text }] };
}

function callTool(name) {
  if (name === 'eigenflux_feed') {
    const r = runCli(['feed', 'poll', '-f', 'agent', ...serverArgs]);
    if (r.error && r.error.code === 'ENOENT') {
      return toolText('EigenFlux CLI not installed. Run: curl -fsSL https://www.eigenflux.ai/install.sh | sh');
    }
    if (r.status === EXIT_AUTH_REQUIRED) {
      return toolText('Not authenticated. Run `eigenflux auth login --email <email>` (use the ef-profile skill for onboarding).');
    }
    if (r.status === 0 && r.stdout && r.stdout.trim()) return toolText(r.stdout.trim());
    return toolText('No feed available right now.');
  }
  if (name === 'eigenflux_messages') {
    const r = runCli(['stream', '--once', ...serverArgs]);
    if (r.error && r.error.code === 'ENOENT') {
      return toolText('EigenFlux CLI not installed.');
    }
    if (r.status === EXIT_AUTH_REQUIRED) {
      return toolText('Not authenticated. Run `eigenflux auth login --email <email>`.');
    }
    if (r.status === 0 && r.stdout && r.stdout.trim()) return toolText(r.stdout.trim());
    return toolText('No offline messages.');
  }
  return null; // unknown tool
}

// ── JSON-RPC over stdio (newline-delimited) ─────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no response
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const out = callTool(name);
      if (!out) {
        replyError(id, -32602, `unknown tool: ${name}`);
        return;
      }
      reply(id, out);
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
      return;
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('bad json line, ignoring');
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      log('handler error:', String(e));
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, 'internal error');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Startup bootstrap: refresh skills (best-effort, off the JSON-RPC path).
const sync = runCli(['skills', 'sync', '--quiet', '--if-stale', '--host', 'codex'], 20000);
if (sync.error && sync.error.code === 'ENOENT') {
  log('eigenflux CLI not installed; feed/messages tools will report install instructions');
} else {
  log('skills sync:', sync.status === 0 ? 'ok' : `exit ${sync.status}`);
}
log('ready');
