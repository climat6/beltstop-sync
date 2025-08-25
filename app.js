// Belt Stop Sync — robust Web Bluetooth client for Bluefy
// Implements protocol:
//  HELLO,<device_id>,FW,1.2,<clockSync>,<unsent>,<battery_mv>,<accumStops>
//  CAL,<vib_g_1s>
//  EV,<start_epoch_s>,<duration_ms>,<accumStops>
//  SYNC,DONE,<last_index>
// Commands sent:
//  TIME,UTC,<epoch_s>,<tz_min>
//  CFG,SCHED,<start_m>,<end_m>,<enabled>
//  CFG,THRESH,<th_g>,<hy_g>,<secs_down>,<secs_up>
//  CFG,BREAKS,<b1s_m>,<b1e_m>,<b2s_m>,<b2e_m>,<enabled>
//  MODE,CALIB,ON|OFF
//  SYNC,REQ / SYNC,ACK,<idx>

const NUS_SERVICE = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E'.toLowerCase();
const NUS_RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E'.toLowerCase(); // write
const NUS_TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E'.toLowerCase(); // notify

const ui = {
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  connStatus: document.getElementById('connStatus'),
  deviceName: document.getElementById('deviceName'),
  tzSelect: document.getElementById('tzSelect'),
  btnSendTime: document.getElementById('btnSendTime'),
  winStart: document.getElementById('winStart'),
  winEnd: document.getElementById('winEnd'),
  winEnabled: document.getElementById('winEnabled'),
  btnSendSchedule: document.getElementById('btnSendSchedule'),
  b1Start: document.getElementById('b1Start'),
  b1End: document.getElementById('b1End'),
  b2Start: document.getElementById('b2Start'),
  b2End: document.getElementById('b2End'),
  breaksEnabled: document.getElementById('breaksEnabled'),
  btnSendBreaks: document.getElementById('btnSendBreaks'),
  btnCalOn: document.getElementById('btnCalOn'),
  btnCalOff: document.getElementById('btnCalOff'),
  vibG: document.getElementById('vibG'),
  thresh: document.getElementById('thresh'),
  hyst: document.getElementById('hyst'),
  secsDown: document.getElementById('secsDown'),
  secsUp: document.getElementById('secsUp'),
  btnSendThresh: document.getElementById('btnSendThresh'),
  btnSync: document.getElementById('btnSync'),
  syncInfo: document.getElementById('syncInfo'),
  shiftStops: document.getElementById('shiftStops'),
  lastStop: document.getElementById('lastStop'),
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

// IndexedDB
const DB_NAME = 'beltstop-db';
const DB_VER = 2;
let db;

async function openDB() {
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

function loadSetting(k, defVal) {
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

function toMinutesOfDay(date) {
  return date.getHours()*60 + date.getMinutes();
}

function toCSV(events) {
  const rows = [['date','start_iso8601','duration_ms','duration_hms','device_id','accum_stops']];
  for (const e of events) {
    const d = new Date(e.startEpoch * 1000);
    rows.push([
      d.toLocaleDateString(),
      d.toISOString(),
      e.durationMs,
      formatHMS(e.durationMs),
      e.deviceId || 'unknown',
      e.accumStops ?? ''
    ]);
  }
  return rows.map(r => r.join(',')).join('\n');
}

function formatHMS(ms) {
  let s = Math.floor(ms/1000);
  let h = Math.floor(s/3600);
  s -= h*3600;
  let m = Math.floor(s/60);
  s -= m*60;
  const pad = n => String(n).padStart(2,'0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function download(filename, text, mime='text/csv') {
  const blob = new Blob([text], {type: mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// --- BLE connection
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
  ui.btnSendBreaks.disabled = !on;
  ui.btnSendTime.disabled = !on;
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

// --- Protocol handling
let lastIdxFromDevice = -1;

async function handleLine(line) {
  log('← ' + line);
  const parts = line.split(',');
  switch (parts[0]) {
    case 'HELLO': {
      // HELLO,<device_id>,FW,1.2,<clockSync>,<unsent>,<battery>,<accumStops>
      if (parts.length >= 8) {
        const accum = parseInt(parts[7],10) || 0;
        ui.shiftStops.textContent = String(accum);
      }
      // After hello, push current time/schedule/breaks
      await sendTimeOnly();
      await sendSchedule();
      await sendBreaks();
      break;
    }
    case 'CAL':
      if (parts.length >= 2) {
        const v = parseFloat(parts[1]);
        ui.vibG.textContent = isFinite(v) ? v.toFixed(6) : '0.000000';
      }
      break;
    case 'EV': {
      // EV,<start_epoch_s>,<duration_ms>,<accumStops>
      if (parts.length >= 4) {
        const start = parseInt(parts[1],10) || 0;
        const dur = parseInt(parts[2],10) || 0;
        const accum = parseInt(parts[3],10) || 0;
        await addEvent({ startEpoch: start, durationMs: dur, deviceId: device?.name || 'unknown', accumStops: accum });
        ui.shiftStops.textContent = String(accum);
        ui.lastStop.textContent = `${new Date(start*1000).toLocaleTimeString()} (${formatHMS(dur)})`;
      }
      break;
    }
    case 'SYNC':
      if (parts.length >= 3 && parts[1] === 'DONE') {
        const last = parseInt(parts[2], 10) || 0;
        lastIdxFromDevice = last;
        await writeLine('SYNC,ACK,' + last);
        ui.syncInfo.textContent = 'Sync complete.';
      }
      break;
    default:
      break;
  }
}

// --- Commands
async function sendTimeOnly() {
  const epoch = Math.floor(Date.now()/1000);
  const sel = ui.tzSelect.value;
  const tzMin = parseInt(sel,10);
  await writeLine(`TIME,UTC,${epoch},${tzMin}`);
}

async function sendSchedule() {
  const en = ui.winEnabled.checked ? 1 : 0;
  const sMin = hhmmToMin(ui.winStart.value);
  const eMin = hhmmToMin(ui.winEnd.value);
  await writeLine(`CFG,SCHED,${sMin},${eMin},${en}`);
  await saveSetting('schedule', { en, sMin, eMin });
}

async function sendBreaks() {
  const en = ui.breaksEnabled.checked ? 1 : 0;
  const b1s = hhmmToMin(ui.b1Start.value);
  const b1e = hhmmToMin(ui.b1End.value);
  const b2s = hhmmToMin(ui.b2Start.value);
  const b2e = hhmmToMin(ui.b2End.value);
  await writeLine(`CFG,BREAKS,${b1s},${b1e},${b2s},${b2e},${en}`);
  await saveSetting('breaks', { en, b1s, b1e, b2s, b2e });
}

async function sendThresholds() {
  const th = parseFloat(ui.thresh.value);
  const hy = parseFloat(ui.hyst.value);
  const sd = parseInt(ui.secsDown.value,10);
  const su = parseInt(ui.secsUp.value,10);
  await writeLine(`CFG,THRESH,${th},${hy},${sd},${su}`);
  await saveSetting('thresholds', { th, hy, sd, su });
}

// --- Helpers
function hhmmToMin(hhmm) {
  const [h, m] = hhmm.split(':').map(n => parseInt(n,10)||0);
  return h*60 + m;
}

function populateTZSelect() {
  // Build a list of common offsets: from -12:00 to +14:00 in 30-minute increments
  const sel = ui.tzSelect;
  sel.innerHTML = '';
  const browserOffsetMin = -new Date().getTimezoneOffset(); // minutes east of UTC
  function fmt(min) {
    const sign = min >= 0 ? '+' : '-';
    const a = Math.abs(min);
    const h = Math.floor(a/60), m = a%60;
    return `UTC${sign}${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  for (let m = -720; m <= 840; m += 30) {
    const opt = document.createElement('option');
    opt.value = String(m);
    opt.textContent = fmt(m) + (m===browserOffsetMin ? ' (Browser)' : '');
    if (m === browserOffsetMin) opt.selected = true;
    sel.appendChild(opt);
  }
}

function loadSavedUI() {
  // schedule
  loadSetting('schedule', null).then(s => {
    if (s) {
      ui.winEnabled.checked = !!s.en;
      ui.winStart.value = minToHHMM(s.sMin ?? 0);
      ui.winEnd.value = minToHHMM(s.eMin ?? 0);
    } else {
      ui.winStart.value = '00:00';
      ui.winEnd.value = '09:00';
    }
  });
  // breaks
  loadSetting('breaks', null).then(b => {
    if (b) {
      ui.breaksEnabled.checked = !!b.en;
      ui.b1Start.value = minToHHMM(b.b1s ?? 225);
      ui.b1End.value   = minToHHMM(b.b1e ?? 240);
      ui.b2Start.value = minToHHMM(b.b2s ?? 360);
      ui.b2End.value   = minToHHMM(b.b2e ?? 390);
    }
  });
  // thresholds
  loadSetting('thresholds', null).then(t => {
    if (t) {
      ui.thresh.value = t.th ?? 0.003;
      ui.hyst.value   = t.hy ?? 0.0015;
      ui.secsDown.value = t.sd ?? 5;
      ui.secsUp.value   = t.su ?? 3;
    }
  });
  // export day default
  ui.expDay.value = new Date().toISOString().slice(0,10);
  ui.expYear.value = String(new Date().getFullYear());
  ui.expMonth.value = String(new Date().getMonth()+1);
}

function minToHHMM(mins) {
  const h = Math.floor(mins/60);
  const m = mins % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// --- Exports
async function exportDayCSV(dateStr) {
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

// --- UI hooks
ui.btnConnect.addEventListener('click', connect);
ui.btnDisconnect.addEventListener('click', () => device?.gatt?.disconnect());

ui.btnSendTime.addEventListener('click', sendTimeOnly);
ui.btnSendSchedule.addEventListener('click', sendSchedule);
ui.btnSendBreaks.addEventListener('click', sendBreaks);
ui.btnSendThresh.addEventListener('click', sendThresholds);

ui.btnCalOn.addEventListener('click', async ()=> { await writeLine('MODE,CALIB,ON'); ui.btnCalOff.disabled = false; });
ui.btnCalOff.addEventListener('click', async ()=> { await writeLine('MODE,CALIB,OFF'); });

ui.btnSync.addEventListener('click', async ()=> { ui.syncInfo.textContent = 'Syncing...'; await writeLine('SYNC,REQ'); });

ui.btnExpDay.addEventListener('click', async ()=> {
  if (!ui.expDay.value) { alert('Pick a date'); return; }
  const csv = await exportDayCSV(ui.expDay.value);
  download(`beltstop-day-${ui.expDay.value}.csv`, csv);
});
ui.btnExpMonth.addEventListener('click', async ()=> {
  const y = parseInt(ui.expYear.value, 10), m = parseInt(ui.expMonth.value, 10);
  const csv = await exportMonthCSV(y, m);
  download(`beltstop-month-${y}-${String(m).padStart(2,'0')}.csv`, csv);
});
ui.btnExpAll.addEventListener('click', async ()=> {
  const csv = await exportAllCSV();
  download(`beltstop-all.csv`, csv);
});

// Init
(async () => {
  await openDB();
  populateTZSelect();
  loadSavedUI();
})();