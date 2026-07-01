import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const targetUrl = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const profile = await mkdtemp(join(tmpdir(), 'zj-00363-settlement-review-'));
const port = 9600 + Math.floor(Math.random() * 300);

const proc = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=390,820',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  targetUrl,
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForJsonVersion() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await wait(100);
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
  const res = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

async function navigate(url) {
  await cdp('Page.navigate', { url });
  await wait(600);
}

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Browser.grantPermissions', {
  origin: new URL(targetUrl).origin === 'null' ? undefined : new URL(targetUrl).origin,
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
}).catch(() => {});
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
await navigate(targetUrl);

const successFlow = await evalPage(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const click = selector => document.querySelector(selector).click();
  const input = (selector, value) => {
    const el = document.querySelector(selector);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  localStorage.clear();
  click('#splitTab');
  input('#participantInput', 'Alice'); click('#addParticipant');
  input('#participantInput', 'Bob'); click('#addParticipant');
  input('#participantInput', 'Cara'); click('#addParticipant');
  click('#addItem');
  input('.item-name', '晚餐');
  input('.item-amount', '90');
  input('.advance-input[data-participant="Alice"]', '90');
  const beforeInvalid = localStorage.getItem('split_bill_data');
  input('.advance-input[data-participant="Bob"]', '-5');
  const afterInvalid = localStorage.getItem('split_bill_data');
  click('#generateTransfer');
  await sleep(80);
  const transfers = [...document.querySelectorAll('.transfer-item')].map(item => ({
    direction: item.querySelector('.transfer-direction').innerText.replace(/\\s+/g, ' ').trim(),
    status: item.querySelector('.transfer-status').textContent.trim()
  }));
  click('#copyAllTransfer');
  await sleep(80);
  const toastAfterCopy = document.querySelector('#toast').textContent;
  document.querySelector('.btn-back-calc').click();
  await sleep(80);
  return {
    transfers,
    toastAfterCopy,
    calcResult: document.querySelector('#result').textContent,
    storageBeforeInvalid: beforeInvalid,
    storageAfterInvalid: afterInvalid,
    scrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  };
})()`);

await cdp('Page.reload');
await wait(600);
const afterReload = await evalPage(`(() => ({
  participants: [...document.querySelectorAll('.participant-tag span:first-child')].map(el => el.textContent),
  advanceInputs: [...document.querySelectorAll('.advance-input')].map(el => ({ name: el.dataset.participant, value: el.value })),
  generateVisible: getComputedStyle(document.querySelector('#generateTransfer')).display,
  stored: localStorage.getItem('split_bill_data'),
  visibleHint: document.querySelector('#advanceInputGroup').textContent.trim()
}))()`);

const fileUrl = 'file://' + resolve('index.html');
await navigate(fileUrl);
const fileFlow = await evalPage(`(async () => {
  const click = selector => document.querySelector(selector).click();
  const input = (selector, value) => {
    const el = document.querySelector(selector);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  localStorage.clear();
  click('#splitTab');
  input('#participantInput', '甲'); click('#addParticipant');
  input('#participantInput', '乙'); click('#addParticipant');
  click('#addItem');
  input('.item-amount', '40');
  input('.advance-input[data-participant="甲"]', '40');
  click('#generateTransfer');
  await new Promise(r => setTimeout(r, 80));
  return {
    transferCount: document.querySelectorAll('.transfer-item').length,
    firstTransfer: document.querySelector('.transfer-direction')?.innerText.replace(/\\s+/g, ' ').trim() || '',
    errors: document.querySelector('#toast').className
  };
})()`);

const result = { successFlow, afterReload, fileFlow };
const failures = [];
if (successFlow.transfers.length !== 2) failures.push('多人分摊后应生成两条最少转账建议');
if (!successFlow.transfers.every(t => t.status.includes('待转账'))) failures.push('转账建议应显示待转账状态');
if (successFlow.calcResult !== '30.00') failures.push('单笔转账金额应能带回计算器');
if (successFlow.storageBeforeInvalid !== successFlow.storageAfterInvalid) failures.push('负数垫付不应污染 localStorage');
if (successFlow.scrollWidth > successFlow.viewport) failures.push('窄屏不应出现横向溢出');
if (afterReload.advanceInputs.length !== 3) failures.push('刷新后应恢复每位参与人的垫付输入框');
if (!afterReload.advanceInputs.some(i => i.name === 'Alice' && i.value === '90')) failures.push('刷新后应恢复 Alice 的 90 元垫付金额');
if (afterReload.generateVisible === 'none') failures.push('刷新恢复分摊方案后应可直接生成转账建议');
if (fileFlow.transferCount !== 1 || !fileFlow.firstTransfer.includes('乙') || !fileFlow.firstTransfer.includes('甲')) failures.push('file:// 核心结算链路应无报错并生成转账');

console.log(JSON.stringify({ result, failures }, null, 2));
ws.close();
proc.kill();
process.exit(failures.length ? 1 : 0);
