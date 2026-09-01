import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function invokeFeed(version) {
  const home = mkdtempSync(join(tmpdir(), 'codex-eigenflux-cli-gate-'));
  const fakeCLI = join(home, 'eigenflux');
  const calls = join(home, 'calls.log');
  writeFileSync(fakeCLI, `#!/bin/sh
printf '%s|%s\\n' "$EIGENFLUX_HOME" "$*" >> "${calls}"
case "$*" in
  "version --short") printf '%s\\n' '${version}' ;;
  "profile refresh-status -f json") printf '%s\\n' '{}' ;;
  "feed poll -f agent") printf '%s\\n' 'FEED_OK' ;;
  *) exit 0 ;;
esac
`, { mode: 0o700 });
  chmodSync(fakeCLI, 0o700);

  const request = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'eigenflux_feed', arguments: {} },
  }) + '\n';
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], {
    input: request,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, EIGENFLUX_HOME: join(home, '.eigenflux'), EIGENFLUX_BIN: fakeCLI },
  });
  assert.equal(run.status, 0, run.stderr);
  return { response: JSON.parse(run.stdout.trim()), calls: readFileSync(calls, 'utf8'), eigenfluxHome: join(home, '.eigenflux') };
}

test('CLI 0.0.34 is blocked before the feed workflow executes', () => {
  const result = invokeFeed('0.0.34');
  assert.match(result.response.result.content[0].text, /0\.0\.35 or newer is required/);
  assert.doesNotMatch(result.calls, /feed poll/);
});

test('CLI 0.0.35 passes the hard gate and executes the feed workflow', () => {
  const result = invokeFeed('0.0.35');
  assert.match(result.response.result.content[0].text, /^FEED_OK/);
  assert.match(result.calls, /feed poll -f agent/);
  for (const line of result.calls.trim().split('\n')) {
    assert.ok(line.startsWith(`${result.eigenfluxHome}|`), `CLI escaped the Codex Agent Home: ${line}`);
  }
});
