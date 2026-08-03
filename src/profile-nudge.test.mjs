import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./mcp-server.mjs', import.meta.url), 'utf8');
const nudgeStart = source.indexOf("' It has been over a day since the last profile check");
const nudgeEnd = source.indexOf("\n  }\n  return ins;", nudgeStart);
const nudge = source.slice(nudgeStart, nudgeEnd);

test('periodic profile nudge uses the versioned field-level flow', () => {
  assert.ok(nudge.includes('profile refresh-context'));
  assert.ok(nudge.includes('profile patch'));
  assert.ok(nudge.includes('Preserve human edits'));
  assert.ok(nudge.includes('do not patch when nothing changed'));
  assert.ok(!nudge.includes('profile update'));
});
