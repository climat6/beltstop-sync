// Belt Stop Sync — Web Bluetooth (Bluefy-friendly)
// Talks to Nordic UART Service and implements the ASCII protocol from the XIAO firmware.
// Stores events in IndexedDB and provides CSV exports.

const NUS_SERVICE = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E'.toLowerCase();
const NUS_RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E'.toLowerCase(); // write
const NUS_TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E'.toLowerCase(); // notify

// --- UI handles
const ui = {
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  connStatus: document.getElementById('connStatus'),
  deviceName: document.getElementById('deviceName'),
  btnCalOn: document.getElementById('btnCalOn'),
  btnCalOff: document.getElementById('btnCalOff'),
  vibG: document.getElementById('vibG'),
  thresh: document.getElementById('thresh'),
  hyst: document.getElementById('hyst'),
  secsDown: document.getElementById('secsDown'),
  secsUp: document.getElementById('secsUp'),
  btnSendThresh: document.getElementById('btnSendThresh'),
  winEnabled: document.getElementById('winEnabled'),
  winStart: document.getElementById('winStart'),
  winEnd: document.getElementById('winEnd'),
  btnSendSchedule: document.getElementById('btnSendSchedule'),
  btnSync: document.getElementById('btnSync'),
  syncInfo: document.getElementById('syncInfo'),
  log: document.getElementById('log'),
  expDay: document.getElementById('expDay'),
  btnExpDay: document.getElementById('btnExpDay'),
  expYear: document.getElementById('expYear'),
  expMonth: document.getElementById('expMonth'),
  btnExpMonth: document.getElementById('btnExpMonth'),
  btnExpAll: document.getElementById('btnExpAll'),
};

function log(s) {
  const d = new Date().toISOString().replace('T',' ').replace('Z','');
  ui.log.textContent += `[${d}] ${s}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}

let device, server, service, rxChar, txChar;
let lineBuffer = '';

// --- IndexedDB: events(startEpoch, durationMs, deviceId)
const DB_NAME = 'beltstop-db';
const DB_VER = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('events')) {
        const st = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        st.createIndex('startEpoch', 'startEpoch');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function saveSetting(k, v) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({k, v});
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

async function loadSetting(k, defVal) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const req = tx.objectStore('settings').get(k);
    req.onsuccess = () => resolve(req.result ? req.result.v : defVal);
    req.onerror = () => reject(req.error);
  });
}

function addEvent(ev) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readwrite');
    tx.objectStore('events').add(ev);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

function queryEventsByRange(fromEpoch, toEpoch) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readonly');
    const st = tx.objectStore('events');
    const ix = st.index('startEpoch');
    const range = IDBKeyRange.bound(fromEpoch, toEpoch, false, false);
    const out = [];
    ix.openCursor(range).onsuccess = e => {
      const cur = e.target.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function exportDayCSV(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  const d = new Date(dateStr + 'T00:00:00');
  const from = Math.floor(d.getTime()/1000);
  const to = from + 86400 - 1;
  const events = await queryEventsByRange(from, to);
  return toCSV(events);
}

async function exportMonthCSV(year, month) {
  const from = Math.floor(new Date(`${year}-${String(month).padStart(2,'0')}-01T00:00:00`).getTime()/1000);
  const nextMonth = month === 12 ? new Date(`${year+1}-01-01T00:00:00`) : new Date(`${year}-${String(month+1).padStart(2,'0')}-01T00:00:00`);
  const to = Math.floor(nextMonth.getTime()/1000) - 1;
  const events = await queryEventsByRange(from, to);
  return toCSV(events);
}

async function exportAllCSV() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('events', 'readonly');
    const st = tx.objectStore('events');
    const out = [];
    st.openCursor().onsuccess = e => {
      const cur = e.target.result;
      if (cur) { out.push(cur.value); cur.continue(); }
      else resolve(toCSV(out));
    };
    tx.onerror = () => reject(tx.error);
  });
}

function toCSV(events) {
  const rows = [['date','start_iso8601','duration_ms','device_id']];
  for (const e of events) {
    const d = new Date(e.startEpoch * 1000);
    rows.push([d.toLocaleDateString(), d.toISOString(), e.durationMs, e.deviceId || 'unknown']);
  }
  return rows.map(r => r.join(',')).join('\n');
}

function download(filename, text, mime='text/plain') {
  const blob = new Blob([text], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// --- BLE helpers
async function connect() {
  try {
    if (!navigator.bluetooth) {
      alert('This browser does not support Web Bluetooth. On iOS, use the Bluefy app.');
      return;
    }
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BeltStop-' }],
      optionalServices: [NUS_SERVICE]
    });
    device = dev;
    device.addEventListener('gattserverdisconnected', onDisconnected);
    server = await device.gatt.connect();
    service = await server.getPrimaryService(NUS_SERVICE);
    rxChar = await service.getCharacteristic(NUS_RX);
    txChar = await service.getCharacteristic(NUS_TX);
    await txChar.startNotifications();
    txChar.addEventListener('characteristicvaluechanged', onNotify);
    setConnected(true);
    log('Connected. Subscribed to notifications.');
    // Upon connect, send time + schedule + thresholds
    await sendTimeAndSchedule();
    await sendThresholds();
  } catch (e) {
    log('Connect error: ' + e);
  }
}

function setConnected(on) {
  ui.btnConnect.disabled = on;
  ui.btnDisconnect.disabled = !on;
  ui.btnCalOn.disabled = !on;
  ui.btnSendThresh.disabled = !on;
  ui.btnSendSchedule.disabled = !on;
  ui.btnSync.disabled = !on;
  ui.btnCalOff.disabled = !on;
  ui.connStatus.textContent = on ? 'Connected' : 'Disconnected';
  ui.deviceName.textContent = on && device ? (device.name || device.id) : '—';
}

function onDisconnected() {
  setConnected(false);
  log('Disconnected.');
}

function onNotify(e) {
  const v = new TextDecoder().decode(e.target.value);
  lineBuffer += v;
  let idx;
  while ((idx = lineBuffer.indexOf('\n')) >= 0) {
    const line = lineBuffer.slice(0, idx).trim();
    lineBuffer = lineBuffer.slice(idx+1);
    if (line.length) handleLine(line);
  }
}

function writeLine(s) {
  if (!rxChar) return;
  const data = new TextEncoder().encode(s + '\n');
  return rxChar.writeValue(data);
}

function handleLine(line) {
  log('← ' + line);
  const parts = line.split(',');
  if (parts[0] === 'HELLO') {
    // Ask for sync immediately
    writeLine('SYNC,REQ');
  } else if (parts[0] === 'CAL' && parts.length >= 2) {
    ui.vibG.textContent = parseFloat(parts[1]).toFixed(6);
  } else if (parts[0] === 'EV' && parts.length >= 3) {
    const start = parseInt(parts[1], 10) || 0;
    const dur = parseInt(parts[2], 10) || 0;
    addEvent({ startEpoch: start, durationMs: dur, deviceId: device?.name || 'unknown' });
  } else if (parts[0] === 'SYNC' && parts[1] === 'DONE' && parts.length >= 3) {
    const last = parseInt(parts[2], 10) || 0;
    writeLine('SYNC,ACK,' + last);
    ui.syncInfo.textContent = 'Sync complete.';
  }
}

// --- Commands
async function sendTimeAndSchedule() {
  const epoch = Math.floor(Date.now()/1000);
  const tzMin = -new Date().getTimezoneOffset(); // minutes east of UTC
  await writeLine(`TIME,UTC,${epoch},${tzMin}`);

  const en = ui.winEnabled.checked ? 1 : 0;
  const [sh, sm] = ui.winStart.value.split(':').map(Number);
  const [eh, em] = ui.winEnd.value.split(':').map(Number);
  const sMin = (sh||0)*60 + (sm||0);
  const eMin = (eh||0)*60 + (em||0);
  await writeLine(`CFG,SCHED,${sMin},${eMin},${en}`);

  // persist in settings
  await saveSetting('schedule', {en, sMin, eMin});
}

async function sendThresholds() {
  const th = parseFloat(ui.thresh.value);
  const hy = parseFloat(ui.hyst.value);
  const sd = parseInt(ui.secsDown.value,10);
  const su = parseInt(ui.secsUp.value,10);
  await writeLine(`CFG,THRESH,${th},${hy},${sd},${su}`);
  await saveSetting('thresholds', {th, hy, sd, su});
}

// --- UI events
ui.btnConnect.addEventListener('click', connect);
ui.btnDisconnect.addEventListener('click', () => device?.gatt?.disconnect());
ui.btnCalOn.addEventListener('click', async () => { await writeLine('MODE,CALIB,ON'); ui.btnCalOff.disabled = false; });
ui.btnCalOff.addEventListener('click', async () => { await writeLine('MODE,CALIB,OFF'); });
ui.btnSendThresh.addEventListener('click', sendThresholds);
ui.btnSendSchedule.addEventListener('click', sendTimeAndSchedule);
ui.btnSync.addEventListener('click', async () => { ui.syncInfo.textContent = 'Syncing...'; await writeLine('SYNC,REQ'); });

ui.btnExpDay.addEventListener('click', async () => {
  if (!ui.expDay.value) { alert('Pick a date'); return; }
  const csv = await exportDayCSV(ui.expDay.value);
  download(`beltstop-day-${ui.expDay.value}.csv`, csv, 'text/csv');
});
ui.btnExpMonth.addEventListener('click', async () => {
  const y = parseInt(ui.expYear.value, 10), m = parseInt(ui.expMonth.value, 10);
  const csv = await exportMonthCSV(y, m);
  download(`beltstop-month-${y}-${String(m).padStart(2,'0')}.csv`, csv, 'text/csv');
});
ui.btnExpAll.addEventListener('click', async () => {
  const csv = await exportAllCSV();
  download(`beltstop-all.csv`, csv, 'text/csv');
});

// Load saved settings on first run
(async () => {
  await openDB();
  const s = await loadSetting('schedule', null);
  if (s) {
    ui.winEnabled.checked = !!s.en;
    const sh = Math.floor(s.sMin/60), sm = s.sMin % 60;
    const eh = Math.floor(s.eMin/60), em = s.eMin % 60;
    ui.winStart.value = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
    ui.winEnd.value = `${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}`;
  }
  const t = await loadSetting('thresholds', null);
  if (t) {
    ui.thresh.value = t.th;
    ui.hyst.value = t.hy;
    ui.secsDown.value = t.sd;
    ui.secsUp.value = t.su;
  }
  // defaults for export day picker
  const today = new Date();
  ui.expDay.value = today.toISOString().slice(0,10);
  ui.expYear.value = String(today.getFullYear());
  ui.expMonth.value = String(today.getMonth()+1);
})();