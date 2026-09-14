import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveRuntimeHost } from './runtime-identity.mjs';

test('unknown Codex product version is never borrowed from the plugin', () => {
  assert.equal(resolveRuntimeHost(), 'codex');
  assert.equal(resolveRuntimeHost('Codex/0.127.0'), 'codex/0.127.0');
  assert.throws(() => resolveRuntimeHost('terminal'), /EIGENFLUX_HOST_OVERRIDE/);
});

async function runFeed(reportExitCode, reportOutput = 'settings reported', model = '') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-runtime-'));
  const binary = join(dir, 'eigenflux');
  const logfile = join(dir, 'calls.jsonl');
  mkdirSync(join(dir, '.codex'));
  writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "configured-default"\n');
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_RUNTIME_LOG, JSON.stringify({args,host:process.env.EIGENFLUX_HOST,mode:process.env.EIGENFLUX_MODE,model:process.env.EIGENFLUX_MODEL,pluginVersion:process.env.EIGENFLUX_PLUGIN_VERSION})+'\\n');
if(args[0]==='feed') console.log('FEED_PAYLOAD');
if(args[0]==='settings') {console.log(${JSON.stringify(reportOutput)});process.exit(${reportExitCode});}
`, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], {
    env: {...process.env, HOME:dir, EIGENFLUX_HOME:dir, EIGENFLUX_BIN:binary,
      EIGENFLUX_SERVER:'staging', EIGENFLUX_HOST:'openclaw/old-plugin',
      EIGENFLUX_HOST_OVERRIDE:'', EIGENFLUX_MODE:'plugin', EIGENFLUX_MODEL:model, TEST_RUNTIME_LOG:logfile},
    stdio:['pipe','pipe','pipe'],
  });
  const result = {stdout:'',stderr:''};
  child.stdout.on('data', chunk => {result.stdout += chunk;});
  child.stderr.on('data', chunk => {result.stderr += chunk;});
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'eigenflux_feed',arguments:{}}})+'\n');
    const deadline = Date.now()+8000;
    while ((!result.stdout.includes('"id":1') || !result.stderr.includes('settings ')) && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(result.stdout.includes('"id":1'), result.stderr);
    assert.ok(result.stderr.includes('settings '), 'report completed while MCP remained connected');
    const calls = readFileSync(logfile, 'utf8').trim().split('\n').map(JSON.parse);
    return {result, calls};
  } finally {
    child.stdin.end();
    const cleanup = setTimeout(()=>child.kill(),5000);
    await closed;
    clearTimeout(cleanup);
    rmSync(dir, { recursive:true, force:true });
  }
}

test('MCP feed children get current product and skill mode, and report deterministically', async () => {
  const {result,calls} = await runFeed(0);
  const feed = calls.find(c => c.args[0] === 'feed');
  const reports = calls.filter(c => c.args[0] === 'settings');
  assert.equal(feed.host, 'codex');
  assert.equal(feed.mode, 'skill');
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].args, ['settings','push','--mode','skill','-s','staging']);
  assert.equal(reports[0].pluginVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  assert.equal(JSON.parse(result.stdout).result.content[0].text, 'FEED_PAYLOAD');
});

for (const model of ['', 'actual-current-model']) {
  test(`Feed and settings children use only an explicitly supplied model: ${model || 'unknown'}`, async () => {
    const { calls } = await runFeed(0, 'settings reported', model);
    for (const command of ['feed', 'settings']) {
      assert.equal(calls.find(call => call.args[0] === command).model, model);
    }
  });

  test(`headless heartbeat does not infer a model from config: ${model || 'unknown'}`, () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-cron-model-'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "configured-default"\n');
    try {
      const result = spawnSync('bash', [fileURLToPath(new URL('../scripts/heartbeat.sh', import.meta.url)), 'print', '--every', '15'], {
        encoding: 'utf8', env: { ...process.env, HOME: home, CODEX_BIN: process.execPath, EIGENFLUX_MODEL: model },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /configured-default/);
      if (model) assert.match(result.stdout, /EIGENFLUX_MODEL=actual-current-model/);
      else assert.doesNotMatch(result.stdout, /EIGENFLUX_MODEL=/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('a report failure preserves the successful Feed response', async () => {
  const {result} = await runFeed(4, '');
  assert.equal(JSON.parse(result.stdout).result.content[0].text, 'FEED_PAYLOAD');
  assert.match(result.stderr, /settings report failed/);
});

test('unchanged reports are not logged as new uploads', async () => {
  const {result} = await runFeed(0, 'settings unchanged; nothing to report');
  assert.match(result.stderr, /settings unchanged/);
  assert.doesNotMatch(result.stderr, /settings reported/);
});

test('headless heartbeat print emits a product name and explicit skill mode', () => {
  const result = spawnSync('bash', [fileURLToPath(new URL('../scripts/heartbeat.sh', import.meta.url)), 'print', '--every', '15'], {
    encoding:'utf8', env:{...process.env,CODEX_BIN:process.execPath},
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EIGENFLUX_HOST=codex EIGENFLUX_MODE=skill/);
  assert.doesNotMatch(result.stdout, /EIGENFLUX_HOST=codex\//);
  assert.match(result.stdout, /EIGENFLUX_PLUGIN_VERSION=/);
});

for (const host of ['plugin', 'skill/1', 'skills', 'unknown', 'terminal/1']) {
  test(`rejects mode sentinel ${host} as a product`, () => {
    assert.throws(() => resolveRuntimeHost(host), /EIGENFLUX_HOST_OVERRIDE/);
  });
}

test('Feed and MCP ping return while a settings report is pending', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'codex-report-pending-'));
  const binary = join(dir, 'eigenflux');
  const release = join(dir, 'release');
  const started = join(dir, 'started');
  writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0]==='feed') console.log('FEED_PAYLOAD');
if(args[0]==='settings') {
  fs.writeFileSync(process.env.TEST_REPORT_STARTED, '1');
  const timer=setInterval(()=>{if(fs.existsSync(process.env.TEST_REPORT_RELEASE)){clearInterval(timer);console.log('settings reported');}},10);
  setTimeout(()=>process.exit(1),4000).unref();
}
`, { mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))], {
    env:{...process.env,HOME:dir,EIGENFLUX_HOME:dir,EIGENFLUX_BIN:binary,
      EIGENFLUX_HOST_OVERRIDE:'',TEST_REPORT_STARTED:started,TEST_REPORT_RELEASE:release},
    stdio:['pipe','pipe','pipe'],
  });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'eigenflux_feed',arguments:{}}})+'\n');
    const deadline = Date.now()+2500;
    while (!existsSync(started) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(existsSync(started), 'report child started');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'ping'})+'\n');
    while (!stdout.includes('"id":2') && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.ok(stdout.includes('"id":1') && stdout.includes('FEED_PAYLOAD'), 'Feed response did not wait for report');
    assert.ok(stdout.includes('"id":2'), 'MCP event loop remains responsive');
  } finally {
    writeFileSync(release, '1');
    child.stdin.end();
    const cleanup = setTimeout(()=>child.kill(),5000);
    await closed;
    clearTimeout(cleanup);
    rmSync(dir,{recursive:true,force:true});
  }
});
