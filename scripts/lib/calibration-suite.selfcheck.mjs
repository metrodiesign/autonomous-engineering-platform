// Offline self-check for the calibration-suite loader (no model, no network):
//   node scripts/lib/calibration-suite.selfcheck.mjs
// Fails loudly (assert) if the branchy load/score logic breaks.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';
import { loadSuite, isAuthored, outcomePassed, UNAUTHORED } from './calibration-suite.mjs';

const dir = mkdtempSync(join(tmpdir(), 'cal-selfcheck-'));
const write = (name, obj) => writeFileSync(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));

write('CAL-01.json', { id: 'A', goal: 'g', visible: 'v-test', golden: 'g-test' }); // authored
write('CAL-02.json', { id: 'B', goal: 'g', visible: UNAUTHORED, golden: UNAUTHORED }); // stub
write('CAL-03.json', { id: 'C', goal: 'g' }); // invalid: missing visible/golden
write('bad.json', '{ not json'); // invalid: parse error
write('task.schema.json', { note: 'schema is ignored by the loader' });

const { authored, stubs, invalid } = loadSuite(dir);
assert.equal(authored.length, 1, 'one authored task');
assert.equal(authored[0].id, 'A');
assert.equal(stubs.length, 1, 'one stub task');
assert.equal(stubs[0].id, 'B');
assert.equal(invalid.length, 2, 'two invalid (missing + parse)');

assert.equal(isAuthored({ visible: 'a', golden: 'b' }), true);
assert.equal(isAuthored({ visible: UNAUTHORED, golden: 'b' }), false, 'stub marker is not authored');
assert.equal(isAuthored({ visible: '', golden: 'b' }), false, 'empty is not authored');
assert.equal(isAuthored({ golden: 'b' }), false, 'missing visible is not authored');

assert.equal(outcomePassed('REVIEWING', undefined), true, 'default expected outcome is REVIEWING');
assert.equal(outcomePassed('REVIEWING', 'REJECTED'), false);
assert.equal(outcomePassed('ESCALATED', 'ESCALATED'), true);

assert.equal(loadSuite(join(dir, 'does-not-exist')).authored.length, 0, 'missing dir is empty, not a throw');

console.log('calibration-suite selfcheck OK');
