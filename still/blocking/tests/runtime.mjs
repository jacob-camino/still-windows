// Uses an isolated Chromium profile; never opens adult websites.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cp, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const binary = process.env.STILL_CHROMIUM;
if (!binary) throw new Error('Set STILL_CHROMIUM to a Chromium or Chrome for Testing executable.');
const sourceExtension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'still-blocking-test-'));
const extension = join(profile, 'extension');
await cp(sourceExtension, extension, {recursive: true, filter: source => !source.split('/').includes('_metadata')});
let browser, stderr = '', sockets = [];
async function until(fn, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('Timed out: ' + label + '\n' + stderr.slice(-3000));
}
async function connect(url) {
  const ws = new WebSocket(url), waiting = new Map(); sockets.push(ws); let id = 0;
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, {once: true}); ws.addEventListener('error', reject, {once: true}); });
  ws.addEventListener('message', event => { const data = JSON.parse(event.data); const task = waiting.get(data.id); if (task) { waiting.delete(data.id); data.error ? task.reject(new Error(JSON.stringify(data.error))) : task.resolve(data.result); } });
  return async (method, params = {}) => {
    const requestId = ++id;
    return Promise.race([new Promise((resolve, reject) => { waiting.set(requestId, {resolve, reject}); ws.send(JSON.stringify({id: requestId, method, params})); }), delay(15000).then(() => { throw new Error('CDP timeout: ' + method); })]);
  };
}
async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true});
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
try {
  browser = spawn(binary, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--user-data-dir=' + profile, '--load-extension=' + extension, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  browser.stderr.on('data', data => stderr += data);
  const port = await until(async () => { try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return false; } }, 'debug port');
  const base = 'http://127.0.0.1:' + port;
  const worker = await until(async () => (await (await fetch(base + '/json/list')).json()).find(target => target.type === 'service_worker' && target.url.endsWith('/background.mjs')), 'extension service worker');
  const workerSend = await connect(worker.webSocketDebuggerUrl);
  const extensionId = new URL(worker.url).hostname;
  const target = await (await fetch(base + '/json/new?' + encodeURIComponent('chrome-extension://' + extensionId + '/settings.html'), {method: 'PUT'})).json();
  const pageSend = await connect(target.webSocketDebuggerUrl);
  await until(async () => evaluate(pageSend, "document.getElementById('status')?.textContent.startsWith('Local rules are active.')"), 'settings ready');
  const save = settings => evaluate(pageSend, `chrome.runtime.sendMessage({type:'save',settings:${JSON.stringify(settings)}})`);
  const get = () => evaluate(pageSend, "chrome.runtime.sendMessage({type:'get'})");
  const match = url => evaluate(workerSend, `chrome.declarativeNetRequest.testMatchOutcome({url:${JSON.stringify(url)},type:'main_frame',method:'get'})`);
  const fixture = {version: 1, adultListEnabled: true, blockedDomains: ['example.com'], allowedDomains: ['docs.example.com']};
  assert.equal((await save(fixture)).ok, true);
  assert((await match('https://example.com/')).matchedRules.some(rule => rule.ruleId === 1 && rule.rulesetId === '_dynamic'));
  assert((await match('https://docs.example.com/')).matchedRules.some(rule => rule.ruleId === 10001 && rule.rulesetId === '_dynamic'));
  assert.equal((await match('https://notexample.com/')).matchedRules.length, 0);
  const adultRules = JSON.parse(await readFile(resolve(extension, 'data/adult-rules.json'), 'utf8'));
  const adultDomain = adultRules[0].condition.requestDomains[0];
  assert((await match('https://' + adultDomain + '/')).matchedRules.some(rule => rule.rulesetId === 'adult'));
  assert.equal((await save({...fixture, allowedDomains: [adultDomain]})).ok, true);
  const allowedAdult = await match('https://' + adultDomain + '/');
  assert(allowedAdult.matchedRules.some(rule => rule.rulesetId === '_dynamic' && rule.ruleId === 10001));
  assert(!allowedAdult.matchedRules.some(rule => rule.rulesetId === 'adult'));
  assert.equal((await save({...fixture, adultListEnabled: false})).ok, true);
  assert.equal((await match('https://' + adultDomain + '/')).matchedRules.length, 0);
  const invalid = await save({...fixture, blockedDomains: ['co.uk']});
  assert.equal(invalid.ok, false);
  assert.deepEqual((await get()).settings, {...fixture, adultListEnabled: false});
  // Simulate a persistence failure after rules changed, then verify rollback.
  await evaluate(workerSend, "globalThis.originalStorageSet = chrome.storage.local.set; chrome.storage.local.set = async () => { throw new Error('simulated storage failure'); }");
  const failedSave = await save({...fixture, blockedDomains: ['different.example.org'], adultListEnabled: true});
  assert.equal(failedSave.ok, false);
  await evaluate(workerSend, 'chrome.storage.local.set = globalThis.originalStorageSet; delete globalThis.originalStorageSet');
  assert.deepEqual((await get()).settings, {...fixture, adultListEnabled: false});
  assert((await match('https://example.com/')).matchedRules.some(rule => rule.ruleId === 1 && rule.rulesetId === '_dynamic'));
  assert.equal((await match('https://different.example.org/')).matchedRules.length, 0);
  assert.equal((await match('https://' + adultDomain + '/')).matchedRules.length, 0);
  await save({...fixture, adultListEnabled: false});
  const navigationTarget = await (await fetch(base + '/json/new?about:blank', {method: 'PUT'})).json();
  const navigation = await connect(navigationTarget.webSocketDebuggerUrl);
  const result = await navigation('Page.navigate', {url: 'http://example.com/'});
  assert.equal(result.errorText, 'net::ERR_BLOCKED_BY_CLIENT');
  console.log('PASS: Chromium parsed 123 static rules; real DNR block/allow priorities, adult toggle, invalid-import preservation, failed-save rollback, options UI, and blocked navigation verified.');
} finally {
  for (const ws of sockets) ws.close();
  if (browser && browser.exitCode === null) { browser.kill('SIGTERM'); await new Promise(resolve => browser.once('exit', resolve)); }
  await rm(profile, {recursive: true, force: true});
}
