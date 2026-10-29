import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function bootstrap({ code = 0, stdout = '', missing = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-skills-sync-'));
  const binary = join(dir, 'eigenflux');
  const calls = join(dir, 'calls.jsonl');
  try {
    if (!missing) writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'skills') {
  process.stdout.write(${JSON.stringify(stdout)});
  process.stderr.write('private-token-do-not-log');
  process.exit(${code});
}
if (args[0] === 'doctor') process.stdout.write('{"outdated":true,"latest_version":"test"}');
`, { mode: 0o700 });
    const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: dir, EIGENFLUX_HOME: dir, EIGENFLUX_BIN: binary, EIGENFLUX_HOST_OVERRIDE: '' },
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      const marker = missing ? 'eigenflux CLI not installed' : 'CLI outdated';
      const deadline = Date.now() + 5000;
      while (!stderr.includes(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(stderr.includes(marker), stderr);
      assert.doesNotMatch(stderr, /private-token-do-not-log|skills sync done/);
      return { stderr, calls: missing ? [] : readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
    } finally {
      child.stdin.end();
      const cleanup = setTimeout(() => child.kill(), 1000);
      await closed;
      clearTimeout(cleanup);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('nonzero Skills sync is reported as failed while bootstrap remains available', async () => {
  const { stderr, calls } = await bootstrap({ code: 1 });
  assert.match(stderr, /skills sync failed exit=1/);
  assert.ok(calls.some(args => args[0] === 'doctor'));
  assert.deepEqual(calls[0], ['skills', 'sync', '--quiet', '--if-stale', '--host', 'codex', '--format', 'json']);
});

test('missing CLI retains installation guidance', async () => {
  assert.match((await bootstrap({ missing: true })).stderr, /eigenflux CLI not installed/);
});

test('verified current Skills are logged as verified rather than newly installed', async () => {
  assert.match((await bootstrap({ stdout: JSON.stringify({ verified_manifest: true, source: 'local' }) })).stderr, /skills sync verified/);
});

for (const result of [
  { verified_manifest: false, no_network: true, diagnostics: [{ reason: 'private-token-do-not-log' }] },
  { verified_manifest: false, preserved: ['private-token-do-not-log'], diagnostics: [{ path: 'private-token-do-not-log' }] },
  { verified_manifest: true, preserved: ['private-token-do-not-log'] },
]) {
  test(`successful process with retained content is incomplete: ${JSON.stringify({ no_network: result.no_network, preserved: !!result.preserved })}`, async () => {
    const { stderr } = await bootstrap({ stdout: JSON.stringify(result) });
    assert.match(stderr, /skills sync incomplete/);
    assert.doesNotMatch(stderr, /skills sync verified/);
  });
}

for (const stdout of ['', 'private-token-do-not-log', '{}', 'null']) {
  test(`missing or invalid result is not claimed as verified: ${JSON.stringify(stdout)}`, async () => {
    const { stderr } = await bootstrap({ stdout });
    assert.match(stderr, /skills sync result unavailable/);
    assert.doesNotMatch(stderr, /skills sync verified/);
  });
}
