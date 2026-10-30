'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const ROOT = path.resolve(__dirname, '..');

// Reuse an existing healthy watcher. Never stop another process to free its port.
function probe(port = 4433) {
  return new Promise(resolve => {
    const req = http.get({hostname:'127.0.0.1', port, path:'/api/sessions'}, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(res.statusCode === 200 && Array.isArray(data.sessions) && typeof data.now === 'number' ? 'ready' : 'occupied');
        } catch { resolve('occupied'); }
      });
      res.on('error', () => resolve('occupied'));
    });
    // First collection reads bounded transcripts and native context. Match the
    // dashboard request allowance instead of mistaking a cold scan for another app.
    req.setTimeout(6000, () => req.destroy());
    req.on('error', error => resolve(error.code === 'ECONNREFUSED' ? 'absent' : 'occupied'));
  });
}

async function start() {
  if (['TOWER_PORT', 'TOWER_HOME', 'TOWER_DATA_DIR'].some(name => process.env[name] !== undefined)) {
    throw new Error('Unset the TOWER_PORT, TOWER_HOME, and TOWER_DATA_DIR developer overrides before opening the desktop monitor.');
  }
  if (process.platform !== 'darwin') throw new Error('AI Code currently supports macOS only.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Node.js 22.12 or newer is required.');
  let electron;
  try { electron = require('../window/node_modules/electron'); }
  catch { throw new Error('Run npm run setup in the app folder first, then reopen the launcher.'); }
  if (!fs.existsSync(electron)) throw new Error('Electron is missing. Run npm run setup again.');
  let status = await probe();
  if (status === 'occupied') throw new Error('Another service is using the monitor port. Nothing was stopped.');
  if (status === 'absent') {
    const log = fs.openSync(path.join(ROOT, 'tower.log'), 'a', 0o600);
    let server;
    try {
      server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd:ROOT, detached:true, stdio:['ignore', log, log], env:process.env
      });
      server.on('error', error => console.error('Could not start the monitor:', error.message));
      server.unref();
    } finally { fs.closeSync(log); }
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(250);
      status = await probe();
      if (status === 'ready') break;
      if (status === 'occupied') throw new Error('The monitor port is occupied. Nothing was stopped.');
    }
    if (status !== 'ready') throw new Error('The monitor did not start. Check the local monitor log.');
  }
  const window = spawn(electron, [path.join(ROOT, 'window')], {
    cwd:ROOT, detached:true, stdio:'ignore', env:process.env
  });
  await new Promise((resolve, reject) => { window.once('spawn', resolve); window.once('error', reject); });
  window.unref();
  console.log('AI Code opened.');
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { probe };
