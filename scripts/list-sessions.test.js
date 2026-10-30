'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatRows, pasteLine } = require('./list-sessions');

test('session list shows exact ids, newest first, and filters by title', () => {
  const rows = [
    {id:'codex:old', agent:'codex', fullTitle:'Garden  planner', lastActivity:1},
    {id:'claude:local_new', agent:'claude', fullTitle:'Shop listings', lastActivity:9},
    {agent:'claude', fullTitle:'No id'}
  ];
  assert.deepEqual(formatRows(rows), ['claude:local_new\tClaude\tShop listings', 'codex:old\tCodex\tGarden planner']);
  assert.deepEqual(formatRows(rows, 'GARDEN'), ['codex:old\tCodex\tGarden planner']);
  assert.deepEqual(formatRows(null), []);
});

test('a pasted title with stray spaces still matches, and the ids come back ready to paste', () => {
  const rows = [
    {id:'codex:old', agent:'codex', fullTitle:'Garden planner', lastActivity:1},
    {id:'claude:local_new', agent:'claude', fullTitle:'Garden planner notes', lastActivity:9}
  ];
  assert.deepEqual(formatRows(rows, '  garden\n planner '), ['claude:local_new\tClaude\tGarden planner notes', 'codex:old\tCodex\tGarden planner']);
  assert.equal(pasteLine(rows, 'garden planner'), '"claude:local_new", "codex:old"');
  assert.equal(JSON.parse('[' + pasteLine(rows, 'notes') + ']')[0], 'claude:local_new');
});
