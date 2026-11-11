'use strict';
// GR Mod Android, phase-2 prototype: pick a camera and a ready-made fwdc248b.bin, push it.
// Everything that touches the camera runs natively (GrCameraPlugin / PushSession); this page only drives it.

const $ = (id) => document.getElementById(id);
const Cap = window.Capacitor;
const native = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const Gr = native ? (Cap.registerPlugin ? Cap.registerPlugin('GrCamera') : Cap.Plugins.GrCamera) : null;

const state = { cams: new Map(), address: null, file: null, running: false, logPath: null, lines: [] };

function addLog(text, detail) {
  state.lines.push({ text, detail });
  if (state.lines.length > 3000) state.lines.splice(0, 1000);
  renderLog();
}
function renderLog() {
  const all = $('detail').checked;
  const el = $('log');
  const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  el.textContent = state.lines.filter((l) => all || !l.detail).map((l) => l.text).join('\n');
  if (atEnd) el.scrollTop = el.scrollHeight;
}
$('detail').addEventListener('change', renderLog);

function refreshButtons() {
  const cam = !!state.address && !state.running;
  const fw = cam && state.file && state.file.container;
  $('find').disabled = state.running;
  $('file').disabled = state.running;
  $('info').disabled = !cam;
  $('prep').disabled = !fw;
  $('push').disabled = !fw;
}

function setStage(text, kind) {
  const el = $('stage');
  el.textContent = text;
  el.className = 'stage' + (kind ? ' ' + kind : '');
}

// ------------------------------------------------------------------ cameras

function renderCams() {
  const ul = $('cams');
  ul.textContent = '';
  for (const c of state.cams.values()) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'cam';
    radio.checked = c.address === state.address;
    radio.addEventListener('change', () => { state.address = c.address; refreshButtons(); });
    const text = document.createElement('div');
    const name = document.createElement('div');
    name.textContent = c.name || '（没有名字）';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = c.address + ' · ' + (c.bonded ? '已配对' : '未配对：连接时相机要在配对状态') + (c.rssi ? ' · 信号 ' + c.rssi : '');
    text.append(name, sub);
    label.append(radio, text);
    li.append(label);
    ul.append(li);
  }
  if (!state.cams.size) {
    const li = document.createElement('li');
    li.innerHTML = '<label><div class="sub">没找到相机。相机开着吗？蓝牙打开了吗？GR WORLD 是不是正连着它？</div></label>';
    ul.append(li);
  }
}

function addCam(d) {
  const old = state.cams.get(d.address);
  state.cams.set(d.address, Object.assign({}, old, d, { bonded: d.bonded || (old && old.bonded) }));
  if (!state.address) state.address = d.address;
  renderCams();
  refreshButtons();
}

$('find').addEventListener('click', async () => {
  try {
    const st = await Gr.ensurePermissions();
    if (!st.bluetooth) { alert('请先打开手机蓝牙'); return; }
    $('find').disabled = true;
    $('find').textContent = '正在查找…';
    const bonded = await Gr.bondedCameras();
    for (const d of bonded.devices) addCam(d);
    const r = await Gr.scan({ ms: 8000 });
    for (const d of r.devices) addCam(d);
    renderCams();
  } catch (e) {
    alert('查找相机失败：' + (e.message || e));
  } finally {
    $('find').textContent = '重新查找';
    refreshButtons();
  }
});

// ------------------------------------------------------------------ firmware file

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

$('file').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  state.file = null;
  refreshButtons();
  const box = $('fw-info');
  box.hidden = false;
  box.className = 'info';
  if (!f) { box.hidden = true; return; }
  try {
    box.textContent = '读取 ' + f.name + '…';
    await Gr.fileBegin();
    const CH = 1 << 20;
    for (let o = 0; o < f.size; o += CH) {
      const part = new Uint8Array(await f.slice(o, Math.min(f.size, o + CH)).arrayBuffer());
      await Gr.fileAppend({ data: base64(part) });
      box.textContent = '读取 ' + f.name + '… ' + Math.round(Math.min(f.size, o + CH) / f.size * 100) + '%';
    }
    const info = await Gr.fileEnd();
    state.file = info;
    box.className = 'info' + (info.container ? '' : ' bad');
    box.textContent = info.container
      ? f.name + '：' + info.describe + '\n' + info.size + ' 字节 · SHA-256 ' + info.sha256
      : f.name + '：' + info.error;
    addLog('固件文件 ' + f.name + '：' + (info.container ? info.describe : info.error), false);
  } catch (e) {
    box.className = 'info bad';
    box.textContent = '读取失败：' + (e.message || e);
  }
  refreshButtons();
});

// ------------------------------------------------------------------ the session

async function run(mode) {
  state.running = true;
  state.logPath = null;
  refreshButtons();
  $('run').hidden = false;
  $('share').hidden = true;
  $('cancel').hidden = false;
  $('bar').hidden = true;
  setStage('开始…');
  try {
    await Gr.start({ address: state.address, mode });
  } catch (e) {
    state.running = false;
    setStage('没能开始：' + (e.message || e), 'bad');
    refreshButtons();
  }
}

if (Gr) {
  Gr.addListener('log', (l) => addLog(l.text, l.detail));
  Gr.addListener('found', addCam);
  Gr.addListener('stage', (s) => {
    const kind = s.id === 'done' ? 'ok' : s.id === 'failed' ? 'bad' : '';
    setStage(s.text, kind);
    if (s.id === 'upload') $('bar').hidden = false;
    if (s.id === 'updating') $('cancel').hidden = true;
  });
  Gr.addListener('progress', (p) => {
    const bar = $('bar');
    bar.hidden = false;
    bar.max = p.total;
    bar.value = p.sent;
  });
  Gr.addListener('finished', (r) => {
    state.running = false;
    state.logPath = r.log || null;
    $('cancel').hidden = true;
    $('share').hidden = !state.logPath;
    if (r.camera && r.camera.model) {
      const c = state.cams.get(state.address);
      if (c) { c.bonded = true; renderCams(); }
    }
    refreshButtons();
  });
}

$('info').addEventListener('click', () => run('INFO'));
$('prep').addEventListener('click', () => run('PREPARE_TEST'));
$('push').addEventListener('click', () => {
  const c = state.cams.get(state.address) || {};
  const t = $('confirm-text');
  t.textContent = '';
  const p1 = document.createElement('p');
  p1.textContent = '相机：' + (c.name || state.address);
  const p2 = document.createElement('p');
  p2.textContent = '固件：' + state.file.describe;
  const p3 = document.createElement('p');
  p3.textContent = '连上相机后会先检查机型、版本和电量（低于 50% 不推送），不符合就停下。';
  t.append(p1, p2, p3);
  const d = $('confirm');
  d.returnValue = '';
  d.showModal();
  d.addEventListener('close', function once() {
    d.removeEventListener('close', once);
    if (d.returnValue === 'yes') run('PUSH');
  });
});
$('cancel').addEventListener('click', () => Gr.cancel());
$('share').addEventListener('click', () => { if (state.logPath) Gr.shareLog({ path: state.logPath }); });

if (!native) {
  document.querySelector('main').innerHTML = '<section><p>这个页面要在 GR Mod Android App 里打开。</p></section>';
} else {
  Gr.getStatus().then((s) => { if (!s.bluetooth) $('cam-hint').textContent = '手机蓝牙没开：先打开蓝牙。'; });
  refreshButtons();
}
