import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmployeeCodes, serializeEmployeeCodes } from '../src/domain/colleagues.ts';

test('along-with employee codes are trimmed, deduplicated and stored as a comma-separated list', () => {
  assert.deepEqual(parseEmployeeCodes('E100, E200, E100, , E300 '), ['E100', 'E200', 'E300']);
  assert.equal(serializeEmployeeCodes([' E100 ', 'E200', 'E100', '']), 'E100, E200');
  assert.deepEqual(parseEmployeeCodes(''), []);
});
