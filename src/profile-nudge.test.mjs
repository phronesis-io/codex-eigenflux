import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function runEntryRequests({ missingCLI = false, cliExitCode = 0, stdout = '', stderr = '', profileResults = [] } = {}) {
  const testRoot = mkdtempSync(join(tmpdir(), 'codex-eigenflux-entry-'));
  const fakeCLI = join(testRoot, 'mock-eigenflux');
  try {
    if (!missingCLI) {
      writeFileSync(fakeCLI, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let result = {stdout: '', stderr: '', status: 0};
if (args[0] === 'feed' || args[0] === 'stream') {
  result = ${JSON.stringify({ stdout, stderr, status: cliExitCode })};
}
if (JSON.stringify(args) === JSON.stringify(['profile', 'refresh-task', '--format', 'agent', '-s', 'staging'])) {
  const counter = ${JSON.stringify(join(testRoot, 'profile-count'))};
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
  fs.writeFileSync(counter, String(count + 1));
  result = ${JSON.stringify(profileResults)}[count] || result;
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status || 0);
`, { mode: 0o700 });
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

test('initialize and successful Feed calls forward fresh central profile tasks', () => {
  const [initialized, feed] = runEntryRequests({
    stdout: 'FEED_PAYLOAD',
    profileResults: [{stdout: 'CENTRAL_INITIAL_TASK'}, {stdout: 'CENTRAL_FEED_TASK'}],
  });
  assert.match(initialized.instructions, /CENTRAL_INITIAL_TASK$/);
  assert.equal(feed.content[0].text, 'FEED_PAYLOAD\n\nCENTRAL_FEED_TASK');
  assert.equal(feed.isError, undefined);
});

test('a central empty task adds no profile instructions to successful results', () => {
  const [, feed, messages] = runEntryRequests();
  assert.equal(feed.content[0].text, 'No feed available right now.');
  assert.equal(messages.content[0].text, 'No offline messages.');
  assert.equal(feed.isError, undefined);
  assert.equal(messages.isError, undefined);
});

test('profile errors preserve a successful Feed result and expose central diagnostics', () => {
  const [, feed] = runEntryRequests({
    stdout: 'FEED_PAYLOAD',
    profileResults: [{}, {status: 2, stderr: 'CENTRAL_PROFILE_ERROR'}],
  });
  assert.equal(feed.content[0].text, 'FEED_PAYLOAD\n\nEigenFlux profile refresh check failed:\nCENTRAL_PROFILE_ERROR');
  assert.equal(feed.isError, undefined);
});

test('an older CLI produces an upgrade notice instead of a local profile fallback', () => {
  const error = {status: 2, stderr: 'unknown command "refresh-task" for "eigenflux profile"'};
  const [initialized, feed] = runEntryRequests({profileResults: [error, error]});
  for (const text of [initialized.instructions, feed.content[0].text]) {
    assert.match(text, /requires CLI 0\.0\.46 or newer/);
    assert.match(text, /unknown command "refresh-task"/);
  }
});

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
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(text.includes(installDoc));
    assert.match(text, /host codex/);
    assert.match(text, /EIGENFLUX_HOME/);
    assert.match(text, /\$HOME\/\.eigenflux-codex\/\.eigenflux/);
    assert.doesNotMatch(text, /curl|auth login/);
  }
  assert.deepEqual(feed, messages);
});

for (const cliExitCode of [2, 4, 7]) {
  test(`CLI failure ${cliExitCode} preserves central details and is marked as an MCP tool error`, () => {
    const [, feed, messages] = runEntryRequests({
      cliExitCode,
      stdout: 'CENTRAL_RESULT',
      stderr: 'CENTRAL_ERROR: capability unavailable; Feed remains available',
    });
    for (const result of [feed, messages]) {
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, 'CENTRAL_RESULT\n\nCENTRAL_ERROR: capability unavailable; Feed remains available');
    }
  });
}

test('a CLI failure without diagnostics still reports the failure', () => {
  const [, feed, messages] = runEntryRequests({ cliExitCode: 4 });
  for (const result of [feed, messages]) {
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, 'EigenFlux CLI exited with status 4.');
  }
});

test('initialize defers business decisions to the current plan and dynamic Skills', () => {
  const [initialized] = runEntryRequests({ missingCLI: true });
  assert.match(initialized.instructions, /heartbeat plan --format agent/);
  assert.match(initialized.instructions, /dynamically synced ef-\* Skills/);
  assert.doesNotMatch(initialized.instructions, /call `eigenflux_feed`|`eigenflux_messages` to fetch|Powered by EigenFlux/);
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

test('successful CLI diagnostics retain a ride-along profile reminder', () => {
  const [, feed, messages] = runEntryRequests({stdout: 'PAYLOAD', stderr: '[PENDING TASK] Your EigenFlux profile is due for a refresh.'});
  for (const result of [feed, messages]) {
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].text, 'PAYLOAD\n\n[PENDING TASK] Your EigenFlux profile is due for a refresh.');
  }
});
