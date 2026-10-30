'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { probe } = require('./start');

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('launcher can reuse a healthy local monitor', async t => {
  const port = await fixture(t, (req, res) => {
    assert.equal(req.url, '/api/sessions');
    res.end(JSON.stringify({sessions:[], now:Date.now()}));
  });
  assert.equal(await probe(port), 'ready');
});

test('launcher allows the initial dashboard context scan to finish', async t => {
  const port = await fixture(t, (req, res) => {
    setTimeout(() => res.end(JSON.stringify({sessions:[], now:Date.now()})), 1800);
  });
  assert.equal(await probe(port), 'ready');
});

test('launcher distinguishes a closed port from a running service', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.equal(await probe(port), 'absent');
});

test('launcher leaves unrelated or failed services alone', async t => {
  for (const [status, body] of [[200, '<html>Different app</html>'], [503, '{}'], [200, '{"sessions":[]}']]) {
    const port = await fixture(t, (_, res) => { res.statusCode = status; res.end(body); });
    assert.equal(await probe(port), 'occupied');
  }
});

test('launcher fails closed on stalled or oversized responses', async t => {
  const stalled = await fixture(t, () => {});
  assert.equal(await probe(stalled), 'occupied');
  const oversized = await fixture(t, (_, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  assert.equal(await probe(oversized), 'occupied');
});

test('desktop launcher rejects developer overrides before starting a process', () => {
  const names = ['TOWER_PORT', 'TOWER_HOME', 'TOWER_DATA_DIR'];
  for (const name of names) {
    const env = {...process.env};
    for (const key of names) delete env[key];
    env[name] = name === 'TOWER_PORT' ? '55444' : '/nonexistent-ai-code-test';
    const result = spawnSync(process.execPath, [path.join(__dirname, 'start.js')], {env, encoding:'utf8', timeout:3000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unset the TOWER_PORT, TOWER_HOME, and TOWER_DATA_DIR/);
    assert.equal(result.stdout, '');
  }
});
