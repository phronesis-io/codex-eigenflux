import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(new URL('./mcp-server.mjs', import.meta.url), 'utf8');
const nudgeStart = source.indexOf('function profileRefreshInstruction()');
const nudgeEnd = source.indexOf('\n}\n\nfunction withProfileRefreshNudge', nudgeStart);
const nudge = source.slice(nudgeStart, nudgeEnd);

test('periodic profile nudge only triggers the canonical skill procedure', () => {
  assert.ok(nudge.includes('EigenFlux periodic profile refresh is due'));
  assert.ok(nudge.includes('ef-profile skill'));
  assert.ok(nudge.includes('Periodic Profile Refresh'));
  assert.ok(nudge.includes('only source of truth'));
  for (const duplicatedContract of [
    'profile refresh-context',
    'profile patch',
    'profile refresh-complete',
    'settings push',
    'KEEP, UPDATE, CLEAR, or UNKNOWN',
    'current_focus',
    'network_goal',
    'human_status',
  ]) {
    assert.ok(!nudge.includes(duplicatedContract), duplicatedContract);
  }
});

test('nudge completion follows CLI refresh/check stamps and retries failures', () => {
  assert.ok(source.includes("runCli(['profile', 'refresh-status', '-f', 'json'"));
  assert.ok(source.includes('status.last_touch_unix'));
  assert.ok(source.includes('status.state_scope'));
  assert.ok(!source.includes("servers', serverName, 'credentials.json"));
  assert.ok(source.includes('PROFILE_NUDGE_RETRY_MS'));
  assert.ok(source.includes('lastProfileCompletionMs()'));
  assert.ok(source.includes('withProfileRefreshNudge(r.stdout.trim())'));
});

test('nudge is separated from the fenced feed without duplicating CLI contracts', () => {
  assert.ok(source.includes('`${text.trimEnd()}\\n\\n${profileRefreshInstruction().trimStart()}`'));
  assert.ok(!source.includes('MIN_PROFILE_CLI_VERSION'));
  assert.ok(!source.includes('profileCliPrefix()'));
});

test('feed tool emits only the canonical skill refresh trigger', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-eigenflux-nudge-'));
  const fakeCLI = join(home, 'eigenflux');
  writeFileSync(fakeCLI, `#!/bin/sh
case "$*" in
  "profile refresh-status -f json -s staging")
    printf '%s\\n' '{"server":"staging","agent_id":"42","state_scope":"scope42","last_touch_unix":0}' ;;
  "version --short") printf '%s\\n' '0.0.29' ;;
  "feed poll -f agent -s staging") printf '%s\\n' 'FEED_PAYLOAD' ;;
  "doctor -f json") printf '%s\\n' '{"outdated":false}' ;;
  *) exit 0 ;;
esac
`, { mode: 0o700 });
  chmodSync(fakeCLI, 0o700);

  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'eigenflux_feed', arguments: {} },
  }) + '\n';
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], {
    input: request,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      EIGENFLUX_HOME: join(home, '.eigenflux'),
      EIGENFLUX_BIN: fakeCLI,
      EIGENFLUX_SERVER: 'staging',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const response = JSON.parse(run.stdout.trim());
  const text = response.result.content[0].text;
  assert.match(text, /^FEED_PAYLOAD/);
  assert.match(text, /EigenFlux periodic profile refresh is due/);
  assert.match(text, /ef-profile skill/);
  assert.doesNotMatch(text, /profile refresh-context/);
  assert.doesNotMatch(text, /profile patch/);
});

function runEntryRequests({ missingCLI = false, cliExitCode = 0 } = {}) {
  const testRoot = mkdtempSync(join(tmpdir(), 'codex-eigenflux-entry-'));
  const fakeCLI = join(testRoot, 'mock-eigenflux');
  try {
    if (!missingCLI) {
      writeFileSync(fakeCLI, `#!/bin/sh\nexit ${cliExitCode}\n`, { mode: 0o700 });
    }
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      ...['eigenflux_feed', 'eigenflux_messages'].map((name, index) => ({
        jsonrpc: '2.0', id: index + 2, method: 'tools/call',
        params: { name, arguments: {} },
      })),
    ];
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], {
      input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: testRoot,
        EIGENFLUX_HOME: join(testRoot, '.eigenflux'),
        EIGENFLUX_BIN: fakeCLI,
        EIGENFLUX_SERVER: 'staging',
      },
    });
    assert.equal(run.status, 0, run.stderr);
    const responses = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(responses.length, requests.length);
    return responses.map((response) => response.result);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

const installDoc = 'https://github.com/phronesis-io/eigenflux/blob/main/skills/install.md';

test('missing CLI responses and sandbox setup use the canonical installation document', () => {
  const [initialized, feed, messages] = runEntryRequests({ missingCLI: true });
  assert.ok(initialized.instructions.includes(installDoc));
  assert.match(initialized.instructions, /network_access = true/);
  assert.match(initialized.instructions, /writable_roots = \["~\/\.eigenflux-codex"\]/);
  assert.match(initialized.instructions, /ef-onboarding skill for first-time onboarding/);
  assert.match(initialized.instructions, /ef-profile for existing-account recovery/);
  assert.doesNotMatch(initialized.instructions, /install\.sh/);
  for (const result of [feed, messages]) {
    const text = result.content[0].text;
    assert.ok(text.includes(installDoc));
    assert.match(text, /host codex/);
    assert.match(text, /EIGENFLUX_HOME/);
    assert.match(text, /\$HOME\/\.eigenflux-codex\/\.eigenflux/);
    assert.doesNotMatch(text, /curl|auth login/);
  }
  assert.deepEqual(feed, messages);
});

test('both unauthenticated tools distinguish first-time onboarding from account recovery', () => {
  const [, feed, messages] = runEntryRequests({ cliExitCode: 4 });
  for (const result of [feed, messages]) {
    const text = result.content[0].text;
    assert.match(text, /installed ef-onboarding skill for first-time onboarding/);
    assert.match(text, /ef-profile for existing-account recovery/);
    assert.match(text, /EIGENFLUX_HOME/);
    assert.match(text, /\$HOME\/\.eigenflux-codex\/\.eigenflux/);
    assert.doesNotMatch(text, /auth login|ef-profile skill for onboarding/);
  }
  assert.deepEqual(feed, messages);
});

test('README delegates installation while preserving Codex plugin configuration', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const install = readme.split('## Install\n')[1].split('\n## Already running')[0];
  assert.ok(install.includes(installDoc));
  assert.match(install, /`ef-onboarding` skill for first-time onboarding/);
  assert.match(install, /`ef-profile` for\nexisting-account recovery/);
  assert.match(install, /codex plugin marketplace add phronesis-io\/codex-eigenflux/);
  assert.match(install, /codex plugin add codex-eigenflux@eigenflux/);
  assert.match(install, /Enable the MCP server/);
  assert.match(install, /EIGENFLUX_HOME/);
  assert.doesNotMatch(install, /curl|auth login/);
});
