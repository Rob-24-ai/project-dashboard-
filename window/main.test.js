const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const listeners = new Map();
  const sizes = [];
  const mainFrame = {url:'http://127.0.0.1:4433/'};
  const contents = {mainFrame};
  let bounds = {x:1800, y:900, width:900, height:900};
  const window = {
    isDestroyed:() => false,
    getBounds:() => bounds,
    setBounds:value => { bounds = value; sizes.push(value); }
  };
  const electron = {
    app:{setName(){}, requestSingleInstanceLock:() => true, whenReady:() => ({then(){}}), on(){}},
    ipcMain:{on:(name, listener) => listeners.set(name, listener), handle(){}},
    screen:{getDisplayMatching:() => ({workArea:{x:0, y:0, width:1920, height:1080}})}
  };
  const context = vm.createContext({
    require:name => name === 'electron' ? electron : require(name),
    __dirname, console, URL, setTimeout, clearTimeout, setInterval, clearInterval
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8') +
    '\nglobalThis.attach = (w, v) => {win = w; view = v;};', context);
  context.attach(window, {webContents:contents});
  return {
    sizes,
    changeOrigin:url => { mainFrame.url = url; },
    send:(metrics, overrides = {}) => listeners.get('tower-layout')({sender:contents, senderFrame:mainFrame, ...overrides}, metrics),
    manualResize:() => {bounds = {...bounds, width:570, height:350};}
  };
}

test('window metrics fit Focus, expand the drawer and return to compact Focus', () => {
  const check = fixture();
  check.send({view:'focus',width:410,height:220});
  assert.deepEqual({...check.sizes[0]}, {x:1510,y:836,width:410,height:244});
  check.send({view:'all',width:460,height:520});
  assert.equal(check.sizes.at(-1).height, 544);
  check.send({view:'focus',width:410,height:220});
  assert.equal(check.sizes.at(-1).height, 244);
});

test('unchanged polling does not override a manual resize', () => {
  const check = fixture();
  check.send({view:'focus',width:410,height:220});
  check.manualResize();
  check.send({view:'focus',width:410,height:220});
  assert.equal(check.sizes.length, 1);
});

test('dashboard polling never resizes the user window', () => {
  const check = fixture();
  check.send({view:'desk',width:980,height:760});
  check.manualResize();
  check.send({view:'desk',width:980,height:760});
  assert.equal(check.sizes.length, 0);
});

test('window metrics reject other views, origins, frames and malformed values', () => {
  const check = fixture();
  const good = {view:'focus',width:410,height:220};
  check.send(good, {sender:{}});
  check.send(good, {senderFrame:{url:'http://127.0.0.1:4433/'}});
  check.changeOrigin('https://example.com/');
  check.send(good);
  check.changeOrigin('http://127.0.0.1:4433/');
  for (const metrics of [null, {}, {...good,width:NaN}, {...good,height:Infinity}, {...good,width:-1}, {...good,view:'other'}]) check.send(metrics);
  assert.equal(check.sizes.length, 0);
});

test('finite extreme dimensions stay within compact limits', () => {
  const check = fixture();
  check.send({view:'focus',width:1e10,height:1e10});
  assert.equal(check.sizes.at(-1).width, 620);
  assert.equal(check.sizes.at(-1).height, 480);
  check.send({view:'focus',width:1,height:1});
  assert.equal(check.sizes.at(-1).width, 260);
  assert.equal(check.sizes.at(-1).height, 90);
});

function lifecycleFixture(ownsInstance = true) {
  const EventEmitter = require('node:events');
  const app = new EventEmitter();
  const windows = [], views = [], trays = [], ready = [], handlers = new Map(), writes = [];
  let quitCalls = 0;
  app.setName = () => {};
  app.requestSingleInstanceLock = () => ownsInstance;
  app.whenReady = () => ({then:callback => ready.push(callback)});
  app.quit = () => { quitCalls++; app.emit('before-quit'); for (const window of windows) window.close(); };
  class Window extends EventEmitter {
    constructor(options) { super(); this.bounds = options; this.visible=false;this.destroyed=false;this.focuses=0;this.restores=0;this.contentView={addChildView(){}};windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized || false; }
    restore() { this.minimized=false;this.restores++; }
    show() { this.visible=true; }
    hide() { this.visible=false; }
    focus() { this.focuses++; }
    getBounds() { return this.bounds; }
    getContentSize() { return [this.bounds.width,this.bounds.height]; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile() {}
    close() { let prevented=false;this.emit('close',{preventDefault:()=>{prevented=true;}});if(!prevented){this.destroyed=true;this.emit('closed');}return prevented; }
  }
  class View {
    constructor(options) { this.options=options;this.webContents=new EventEmitter();this.webContents.loadURL=()=>{};this.webContents.getURL=()=>'';views.push(this); }
    setBackgroundColor() {}
    setBounds() {}
  }
  class MockTray extends EventEmitter {
    constructor(icon) { super();this.icon=icon;trays.push(this); }
    setToolTip(value) { this.tooltip=value; }
    setContextMenu(value) { this.menu=value; }
  }
  const electron={app,BrowserWindow:Window,WebContentsView:View,Tray:MockTray,Menu:{buildFromTemplate:value=>value},
    nativeImage:{createFromPath:iconPath=>({path:iconPath,setTemplateImage(value){this.template=value;}})},nativeTheme:{},
    ipcMain:{on(){},handle:(name,handler)=>handlers.set(name,handler)},
    screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1440,height:900}}),getDisplayMatching:()=>({workArea:{x:0,y:0,width:1440,height:900}})}};
  const context=vm.createContext({require:name=>name==='electron'?electron:name==='fs'?{readFileSync(){throw new Error('No saved bounds');},writeFileSync:(file,value)=>writes.push({file,value})}:require(name),
    __dirname,console:{log(){}},URL,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'main.js'),'utf8'),context);
  return {app,windows,views,trays,handlers,writes,quitCalls:()=>quitCalls,ready:()=>{for(const callback of ready.splice(0))callback();}};
}

test('menu bar icon is a native template with Show, Hide and explicit Quit actions',()=>{
  const check=lifecycleFixture();check.ready();
  assert.equal(check.trays.length,1);
  assert.equal(check.trays[0].icon.template,true);
  assert.equal(path.basename(check.trays[0].icon.path),'trayTemplate.png');
  assert.deepEqual(Array.from(check.trays[0].menu,item=>item.label || item.type),['Show Tower','Hide Tower','separator','Quit Tower']);
  check.windows[0].emit('ready-to-show');
  check.trays[0].menu[1].click();
  assert.equal(check.windows[0].visible,false);
  check.trays[0].menu[0].click();
  assert.equal(check.windows[0].visible,true);
  assert.equal(check.windows.length,1);
});

test('titlebar X and native close hide Tower without quitting or removing its tray',()=>{
  const check=lifecycleFixture();check.ready();
  check.windows[0].emit('ready-to-show');
  check.handlers.get('close-window')();
  assert.equal(check.windows[0].visible,false);
  assert.equal(check.windows[0].destroyed,false);
  check.trays[0].menu[0].click();
  assert.equal(check.windows[0].close(),true);
  assert.equal(check.windows[0].visible,false);
  assert.equal(check.quitCalls(),0);
  assert.equal(check.trays.length,1);
  assert.ok(check.writes.length>0,'hide saves the current bounds');
});

test('Quit Tower permits close and flushes bounds, while window-all-closed does not quit',()=>{
  const check=lifecycleFixture();check.ready();
  check.app.emit('window-all-closed');
  assert.equal(check.quitCalls(),0);
  check.trays[0].menu[3].click();
  assert.equal(check.quitCalls(),1);
  assert.equal(check.windows[0].destroyed,true);
  assert.ok(check.writes.length>0);
});

test('relaunch focuses the same restored window and refuses a duplicate process',()=>{
  const check=lifecycleFixture();check.ready();
  check.windows[0].minimized=true;
  check.app.emit('second-instance');check.ready();
  assert.equal(check.windows.length,1);
  assert.equal(check.trays.length,1);
  assert.equal(check.windows[0].restores,1);
  assert.equal(check.windows[0].focuses,1);
  const duplicate=lifecycleFixture(false);duplicate.ready();
  assert.equal(duplicate.quitCalls(),1);
  assert.equal(duplicate.windows.length,0);
  assert.equal(duplicate.trays.length,0);
});

test('menu recreates an unavailable window without duplicating the tray',()=>{
  const check=lifecycleFixture();check.ready();
  check.windows[0].destroyed=true;
  check.windows[0].emit('closed');
  check.trays[0].menu[0].click();
  assert.equal(check.windows.length,2);
  assert.equal(check.trays.length,1);
});

test('menu icon assets provide transparent PNGs at both display scales',()=>{
  for(const scale of [1,2]) {
    const image=fs.readFileSync(path.join(__dirname,scale===1?'trayTemplate.png':'trayTemplate@2x.png'));
    assert.equal(image.subarray(1,4).toString(),'PNG');
    assert.equal(image.readUInt32BE(16),18*scale);
    assert.equal(image.readUInt32BE(20),18*scale);
    assert.equal(image[25],6,'RGBA image preserves the template transparency');
  }
});

test('the Tower page may play its quiet sound cues without a prior click, keeping its isolation',()=>{
  const check=lifecycleFixture();check.ready();
  assert.equal(check.views.length,1);
  const prefs=check.views[0].options.webPreferences;
  assert.equal(prefs.autoplayPolicy,'no-user-gesture-required');
  assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
  assert.equal(path.basename(prefs.preload),'content-preload.js');
});
