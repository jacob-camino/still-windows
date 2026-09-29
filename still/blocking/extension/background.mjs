// SPDX-License-Identifier: GPL-3.0-only
import {DEFAULT_SETTINGS, createDomainNormalizer, validateSettings, customRules} from './core.mjs';

const dnr = chrome.declarativeNetRequest;
let lastError = '';
const normalize = fetch(chrome.runtime.getURL('data/public_suffix_list.dat')).then(r => {
  if (!r.ok) throw new Error('The packaged domain validator could not load.');
  return r.text();
}).then(createDomainNormalizer);

async function installRules(settings) {
  const existing = await dnr.getDynamicRules();
  await dnr.updateDynamicRules({removeRuleIds: existing.map(rule => rule.id), addRules: customRules(settings)});
  await dnr.updateEnabledRulesets(settings.adultListEnabled ? {enableRulesetIds: ['adult']} : {disableRulesetIds: ['adult']});
}

let current = structuredClone(DEFAULT_SETTINGS);
let queue = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const stored = (await chrome.storage.local.get('settings')).settings;
  current = validateSettings(stored ?? DEFAULT_SETTINGS, await normalize);
  await installRules(current);
})().catch(error => { lastError = error.message; });

async function save(value) {
  const next = validateSettings(value, await normalize);
  const previous = current;
  try {
    await installRules(next);
    await chrome.storage.local.set({settings: next});
    current = next;
    lastError = '';
  } catch (error) {
    lastError = error.message;
    try { await installRules(previous); } catch (rollback) { lastError += '; restoring previous rules also failed: ' + rollback.message; }
    throw new Error(lastError);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('settings.html')) return false;
  if (!['get', 'save'].includes(message?.type)) return false;
  const task = queue.then(async () => {
    if (message.type === 'save') await save(message.settings);
    return {ok: true, settings: current, error: lastError, adultEnabled: (await dnr.getEnabledRulesets()).includes('adult'), customRuleCount: (await dnr.getDynamicRules()).length};
  });
  queue = task.catch(() => {});
  task.then(respond, error => respond({ok: false, error: error.message}));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
