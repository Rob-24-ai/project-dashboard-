'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { render, install, stableNode, LABEL } = require('./install-launch-agent');
const ROOT = path.resolve(__dirname, '..');

test('login service template renders a valid plist for this folder and Node', () => {
  const plist = render('/opt/node & co/bin/node', '/Users/someone/AI <tower>');
  assert.match(plist, /<string>\/opt\/node &amp; co\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/Users\/someone\/AI &lt;tower&gt;\/server.js<\/string>/);
  assert.doesNotMatch(plist, /\{\{/);
  assert.match(render(), new RegExp('<string>' + ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/server.js</string>'));
  assert.match(render(), /<key>Label<\/key>\s*<string>local\.tower\.dashboard<\/string>/);
  assert.match(render(), /<key>KeepAlive<\/key>\s*<true\/>/);
  execFileSync('/usr/bin/plutil', ['-lint', '-'], { input: render() });
});

// launchctl, plutil and curl are recorded, never run. Each bootstrap sees the file
// on disk; each health check answers what the running service file would.
function recorder(home, { lint = () => {}, bootstrap = () => {}, health = () => '200' } = {}) {
  const calls = [], target = path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
  let loaded = false;
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (file === '/usr/bin/plutil') return lint(args[args.length - 1]);
    if (file === '/usr/bin/curl') return health(fs.readFileSync(target, 'utf8'));
    if (args[0] === 'bootout') { const was = loaded; loaded = false; if (!was) throw new Error('not loaded'); return; }
    if (args[0] === 'bootstrap') { bootstrap(fs.readFileSync(target, 'utf8')); loaded = true; }
  };
  return { calls, target, run, wait: () => calls.push(['wait']) };
}
const isHealth = call => call[0] === '/usr/bin/curl';
const unreachable = () => { const error = new Error('Command failed: curl'); error.stdout = '000'; throw error; };
const agentFiles = home => fs.readdirSync(path.join(home, 'Library', 'LaunchAgents')).sort();
const OLD = render('/old/node', '/old/tower');

test('installer validates the new service file, then replaces the old service through launchctl only', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  let failures = 1;
  const { calls, target, run, wait } = recorder(home, { bootstrap: () => { if (failures-- > 0) throw new Error('Bootstrap failed: 5'); } });
  assert.equal(install({ home, uid: 501, run, wait }), target);
  assert.equal(fs.readFileSync(target, 'utf8'), render());
  assert.equal(calls[0][0], '/usr/bin/plutil');assert.equal(calls[0][1], '-lint');
  assert.notEqual(calls[0][2], target, 'validated in place of the live service file');
  assert.deepEqual(calls.slice(1, 5), [
    ['/bin/launchctl', 'bootout', 'gui/501/' + LABEL],
    ['/bin/launchctl', 'bootstrap', 'gui/501', target],
    ['wait'],
    ['/bin/launchctl', 'bootstrap', 'gui/501', target]]);
  assert.equal(calls.length, 6, 'one health check after starting, nothing else');
  const check = calls[5];
  assert.ok(isHealth(check), 'did not check that Tower answers');
  assert.equal(check[check.length - 1], 'http://127.0.0.1:4433/');
  assert.ok(check.includes('Host: 127.0.0.1:4433'), 'health check must send the loopback Host');
  assert.deepEqual(agentFiles(home), [LABEL + '.plist']);
});

// KeepAlive means bootstrap succeeds even when the server exits at once, so only
// an answer on 4433 proves the new service works.
test('installer waits for Tower to answer and keeps the new service once it does', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const answers = ['000', '403', '200'];
  const { calls, target, run, wait } = recorder(home, { health: () => { const next = answers.shift(); return next === '000' ? unreachable() : next; } });
  fs.writeFileSync(target, OLD);
  assert.equal(install({ home, uid: 501, run, wait }), target);
  assert.equal(fs.readFileSync(target, 'utf8'), render());
  const afterStart = calls.slice(calls.findIndex(call => call[1] === 'bootstrap') + 1);
  assert.deepEqual(afterStart.map(call => isHealth(call) ? 'check' : call[0] === 'wait' ? 'wait' : call[1]), ['check', 'wait', 'check', 'wait', 'check']);
});

test('installer puts the previous service back when the new one starts but Tower never answers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const { calls, target, run, wait } = recorder(home, { health: text => text === OLD ? '200' : unreachable() });
  fs.writeFileSync(target, OLD);
  assert.throws(() => install({ home, uid: 501, run, wait }), error => {
    assert.match(error.message, /did not answer on http:\/\/127\.0\.0\.1:4433\/ within about 8 seconds/);
    assert.match(error.message, /previous login service was put back and started/);
    return true;
  });
  assert.equal(fs.readFileSync(target, 'utf8'), OLD);
  const steps = calls.slice(calls.findIndex(call => call[1] === 'bootstrap'));
  const checks = steps.filter(isHealth).length;
  assert.equal(checks, 8, 'about 8 seconds of one-second checks');
  assert.equal(steps.filter(call => call[0] === 'wait').length, 7);
  assert.deepEqual(steps.slice(-2), [['/bin/launchctl', 'bootout', 'gui/501/' + LABEL], ['/bin/launchctl', 'bootstrap', 'gui/501', target]],
    'stopped the new service, then started the old one');
  assert.deepEqual(agentFiles(home), [LABEL + '.plist']);
});

test('installer removes a new service that never answers when there was none before', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  const { calls, target, run, wait } = recorder(home, { health: unreachable });
  assert.throws(() => install({ home, uid: 501, run, wait }), /did not answer.*it was removed/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(calls[calls.length - 1], ['/bin/launchctl', 'bootout', 'gui/501/' + LABEL], 'left the new service loaded');
  assert.deepEqual(agentFiles(home), []);
});

test('installer leaves the running service alone when the new file fails validation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const { calls, target, run, wait } = recorder(home, { lint: () => { throw new Error('plist is not valid'); } });
  fs.writeFileSync(target, OLD);
  assert.throws(() => install({ home, uid: 501, run, wait }), /not valid/);
  assert.deepEqual(calls.map(call => call[1]), ['-lint'], 'stopped or started a service');
  assert.equal(fs.readFileSync(target, 'utf8'), OLD);
  assert.deepEqual(agentFiles(home), [LABEL + '.plist']);
});

test('installer restores and restarts the previous service when the new one will not start', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const started = [];
  const { calls, target, run, wait } = recorder(home, { bootstrap: text => { started.push(text); if (text !== OLD) throw new Error('Bootstrap failed: 5'); } });
  fs.writeFileSync(target, OLD);
  assert.throws(() => install({ home, uid: 501, run, wait }), /previous login service was put back/);
  assert.deepEqual(started, [render(), render(), render(), OLD], 'three tries of the new service, then the old one');
  assert.equal(fs.readFileSync(target, 'utf8'), OLD);
  assert.ok(calls.findIndex(call => call[1] === 'bootout') > calls.findIndex(call => call[1] === '-lint'), 'stopped the old service before validating');
  assert.deepEqual(agentFiles(home), [LABEL + '.plist']);
});

test('installer removes its new service file when it will not start and there was none before', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-agent-'));
  const { target, run, wait } = recorder(home, { bootstrap: () => { throw new Error('Bootstrap failed: 5'); } });
  assert.throws(() => install({ home, uid: 501, run, wait }), /Bootstrap failed/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(agentFiles(home), []);
});

test('installer prefers the stable Homebrew link so upgrades do not break the service', () => {
  const brew = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tower-brew-')));
  const cellar = path.join(brew, 'Cellar', 'node@22', '22.1.0', 'bin');
  fs.mkdirSync(cellar, { recursive: true });fs.writeFileSync(path.join(cellar, 'node'), '');
  fs.mkdirSync(path.join(brew, 'opt'));fs.symlinkSync(path.join(brew, 'Cellar', 'node@22', '22.1.0'), path.join(brew, 'opt', 'node@22'));
  assert.equal(stableNode(path.join(cellar, 'node')), path.join(brew, 'opt', 'node@22', 'bin', 'node'));
  fs.unlinkSync(path.join(brew, 'opt', 'node@22'));
  assert.equal(stableNode(path.join(cellar, 'node')), path.join(cellar, 'node'));
  assert.equal(stableNode('/usr/bin/node'), '/usr/bin/node');
});
