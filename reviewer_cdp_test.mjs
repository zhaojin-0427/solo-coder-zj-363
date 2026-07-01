import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const targetUrl = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const profile = await mkdtemp(join(tmpdir(), 'zj-00363-review-'));
const port = 9223 + Math.floor(Math.random() * 500);

const proc = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=390,800',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  targetUrl,
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

async function waitForJsonVersion() {
  const url = `http://127.0.0.1:${port}/json/version`;
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome CDP did not start: ${stderr.slice(0, 500)}`);
}

await waitForJsonVersion();
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = pages.find(item => item.type === 'page') || pages[0];
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evalPage(expression) {
  const res = await cdp('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 800,
  deviceScaleFactor: 1,
  mobile: true,
});
await cdp('Page.navigate', { url: targetUrl });
await new Promise(resolve => setTimeout(resolve, 500));

async function browserReload() {
  await cdp('Page.reload');
  await new Promise(resolve => setTimeout(resolve, 500));
}

await evalPage(`localStorage.clear(); true`);
await browserReload();

const firstFlow = await evalPage(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = selector => document.querySelector(selector).click();
  const num = n => click('[data-num="' + n + '"]');
  const op = o => click('[data-op="' + o + '"]');
  const state = () => ({
    expression: document.querySelector('#expression').textContent,
    result: document.querySelector('#result').textContent,
    history: [...document.querySelectorAll('.history-item')].map(item => ({
      expression: item.querySelector('.history-expression').textContent,
      result: item.querySelector('.history-result').textContent,
    })),
    stored: JSON.parse(localStorage.getItem('calculator_history') || '[]'),
  });

  num(2); op('+'); num(3); click('#equals'); click('#equals'); click('#equals');
  await sleep(50);
  const afterFirst = state();

  document.querySelector('.history-item').click();
  op('*'); num(4); click('#equals');
  await sleep(50);
  const afterReuse = state();

  return { afterFirst, afterReuse };
})()`);

await browserReload();
const afterReload = await evalPage(`({
  expression: document.querySelector('#expression').textContent,
  result: document.querySelector('#result').textContent,
  history: [...document.querySelectorAll('.history-item')].map(item => ({
    expression: item.querySelector('.history-expression').textContent,
    result: item.querySelector('.history-result').textContent,
  })),
  stored: JSON.parse(localStorage.getItem('calculator_history') || '[]'),
})`);

const cleanupFlow = await evalPage(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = selector => document.querySelector(selector).click();
  const num = n => click('[data-num="' + n + '"]');
  const op = o => click('[data-op="' + o + '"]');
  const state = () => ({
    expression: document.querySelector('#expression').textContent,
    result: document.querySelector('#result').textContent,
    history: [...document.querySelectorAll('.history-item')].map(item => ({
      expression: item.querySelector('.history-expression').textContent,
      result: item.querySelector('.history-result').textContent,
    })),
    stored: JSON.parse(localStorage.getItem('calculator_history') || '[]'),
  });

  document.querySelector('.history-delete-btn').click();
  await sleep(50);
  const afterDelete = state();

  click('#historyClear');
  await sleep(50);
  const afterClearHistory = state();

  num(8); op('/'); num(0); click('#equals');
  await sleep(50);
  const afterDivideZero = state();

  click('#clear');
  num(7); op('+'); click('#equals');
  await sleep(50);
  const afterIncomplete = state();

  click('#clear');
  num(9); click('#clear');
  await sleep(50);
  const afterClear = state();

  return {
    afterDelete,
    afterClearHistory,
    afterDivideZero,
    afterIncomplete,
    afterClear,
    url: location.href,
  };
})()`);

const responsive = await evalPage(`(() => {
  const doc = document.documentElement;
  const buttons = [...document.querySelectorAll('.btn')].map(el => el.getBoundingClientRect());
  const historyItems = [...document.querySelectorAll('.history-item')].map(el => el.getBoundingClientRect());
  const calc = document.querySelector('.calculator').getBoundingClientRect();
  const hist = document.querySelector('.history-panel').getBoundingClientRect();
  return {
    viewport: window.innerWidth,
    scrollWidth: doc.scrollWidth,
    calculatorWidth: Math.round(calc.width),
    historyWidth: Math.round(hist.width),
    minButtonWidth: Math.min(...buttons.map(rect => rect.width)),
    maxButtonRight: Math.max(...buttons.map(rect => rect.right)),
    historyOverflow: historyItems.some(rect => rect.right > window.innerWidth || rect.left < 0),
  };
})()`);

const result = { ...firstFlow, afterReload, ...cleanupFlow, responsive };
assert(result.afterFirst.result === '5', '2+3 should equal 5');
assert(result.afterFirst.history.length === 1, 'rapid equals should keep one history entry');
assert(result.afterFirst.history[0].expression === '2+3', 'history should keep full expression');
assert(result.afterFirst.stored.length === 1, 'history should be saved to localStorage');
assert(result.afterReuse.result === '20', 'history result should be reusable in a new calculation');
assert(result.afterReuse.history[0].expression === '5*4', 'reused result calculation should be recorded first');
assert(result.afterReload.history.length === 2, 'reload should restore saved history entries');
assert(result.afterDelete.history.length === 1, 'single delete should remove one record');
assert(result.afterDelete.stored.length === 1, 'single delete should update localStorage');
assert(result.afterClearHistory.history.length === 0, 'clear history should empty visible history');
assert(result.afterClearHistory.stored.length === 0, 'clear history should empty localStorage');
assert(result.afterDivideZero.result === 'Error', 'divide by zero should show Error');
assert(result.afterDivideZero.history.length === 0, 'divide by zero should not create history');
assert(result.afterIncomplete.history.length === 0, 'incomplete expression should not create history');
assert(result.afterClear.history.length === 0, 'clear operation should not create history');
assert(result.responsive.scrollWidth <= result.responsive.viewport, 'narrow viewport should not have horizontal overflow');
assert(!result.responsive.historyOverflow, 'history records should stay inside narrow viewport');

console.log(JSON.stringify(result, null, 2));
ws.close();
proc.kill();
