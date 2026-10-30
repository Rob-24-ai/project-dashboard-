'use strict';
// Installs Tower's server as a login service for this Mac user, so it comes back
// after a restart. Run it yourself with `npm run install-service`; tests never load it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const LABEL = 'local.tower.dashboard';
const TEMPLATE = path.join(__dirname, 'tower.plist.template');

// Homebrew's versioned Cellar folder disappears on upgrade; its opt link does not.
function stableNode(execPath = process.execPath) {
  const match = execPath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/);
  if (!match) return execPath;
  const candidate = path.join(match[1], 'opt', match[2], 'bin', 'node');
  try { return fs.realpathSync(candidate) === fs.realpathSync(execPath) ? candidate : execPath; } catch { return execPath; }
}
function xml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function render(node = stableNode(), root = ROOT) {
  return fs.readFileSync(TEMPLATE, 'utf8').replaceAll('{{NODE}}', xml(node)).replaceAll('{{ROOT}}', xml(root));
}
function bootstrapWithRetry(run, wait, uid, target) {
  for (let attempt = 1; ; attempt++) {
    try { run('/bin/launchctl', ['bootstrap', 'gui/' + uid, target], { stdio: 'inherit' }); return; }
    catch (error) { if (attempt >= 3) throw error; wait(); } // launchd can still be releasing the old service
  }
}
// launchd reports success even when the program exits at once (KeepAlive just
// restarts it), so the only proof the new service works is Tower answering.
const HEALTH_URL = 'http://127.0.0.1:4433/';
const HEALTH_TRIES = 8; // one-second apart: about 8 seconds
function answers(run) {
  try {
    const code = run('/usr/bin/curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '1', '--noproxy', '*', '-H', 'Host: 127.0.0.1:4433', HEALTH_URL],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(code).trim() === '200';
  } catch { return false; } // curl exits non-zero when nothing is listening
}
function waitUntilAnswering(run, wait) {
  for (let attempt = 1; ; attempt++) {
    if (answers(run)) return;
    if (attempt >= HEALTH_TRIES) throw new Error('Tower did not answer on ' + HEALTH_URL + ' within about ' + HEALTH_TRIES + ' seconds; see tower.log');
    wait();
  }
}
function replaceFile(target, text) {
  const temp = target + '.' + process.pid + '.tmp'; // not *.plist, so launchd never loads it
  fs.writeFileSync(temp, text, { mode: 0o644 });
  fs.renameSync(temp, target);
}
// Replaces any earlier Tower service with the same label. The new service file is
// written beside the old one and validated first; the old service keeps running
// until then. If the new one will not start, or starts but Tower never answers
// on 4433, it is stopped and the previous file is put back and started again.
function install({ home = os.homedir(), uid = process.getuid(), run = execFileSync, wait = () => run('/bin/sleep', ['1']) } = {}) {
  const target = path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const text = render();
  const candidate = target + '.' + process.pid + '.new';
  try {
    fs.writeFileSync(candidate, text, { mode: 0o644 });
    run('/usr/bin/plutil', ['-lint', candidate], { stdio: 'ignore' });
    if (!fs.existsSync(path.join(ROOT, 'server.js'))) throw new Error('server.js is missing from ' + ROOT);
  } catch (error) { fs.rmSync(candidate, { force: true }); throw error; }
  let previous = null;
  try { previous = fs.readFileSync(target, 'utf8'); } catch { /* first install */ }
  try { run('/bin/launchctl', ['bootout', 'gui/' + uid + '/' + LABEL], { stdio: 'ignore' }); } catch { /* not loaded yet */ }
  try {
    fs.renameSync(candidate, target);
    bootstrapWithRetry(run, wait, uid, target);
    waitUntilAnswering(run, wait);
  } catch (error) {
    fs.rmSync(candidate, { force: true });
    try { run('/bin/launchctl', ['bootout', 'gui/' + uid + '/' + LABEL], { stdio: 'ignore' }); } catch { /* the new one never loaded */ }
    if (previous === null) { fs.rmSync(target, { force: true }); throw new Error('the new login service would not start (' + error.message + '); it was removed'); }
    replaceFile(target, previous);
    try { bootstrapWithRetry(run, wait, uid, target); }
    catch (restoreError) { throw new Error('the new login service would not start (' + error.message + '), and the previous one, put back, would not start either (' + restoreError.message + ')'); }
    throw new Error('the new login service would not start (' + error.message + '); the previous login service was put back and started');
  }
  return target;
}

if (require.main === module) {
  try {
    if (process.argv.includes('--print')) process.stdout.write(render());
    else {
      if (process.platform !== 'darwin') throw new Error('The login service is for macOS only.');
      const target = install();
      console.log('Tower now starts when you log in to this Mac. Service file: ' + target);
    }
  } catch (error) { console.error('Could not install the login service: ' + error.message); process.exitCode = 1; }
}
module.exports = { render, install, stableNode, LABEL };
