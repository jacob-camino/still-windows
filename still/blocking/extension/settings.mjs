// SPDX-License-Identifier: GPL-3.0-only
import {createDomainNormalizer, parseImport, MAX_IMPORT_BYTES} from './core.mjs';
const $ = id => document.getElementById(id);
let state, pendingImport, normalize;
let busy = false;
function status(text, error = false) { $('status').textContent = text; $('status').dataset.error = String(error); }
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button,input').forEach(element => element.disabled = value);
}
function render() {
  $('adult').checked = state.adultListEnabled;
  for (const [prefix, key] of [['blocked', 'blockedDomains'], ['allowed', 'allowedDomains']]) {
    const list = $(prefix + '-list');
    list.replaceChildren();
    for (const domain of state[key]) {
      const item = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
      label.textContent = domain;
      button.textContent = 'Remove'; button.type = 'button'; button.setAttribute('aria-label', 'Remove ' + domain);
      button.addEventListener('click', () => save({...state, [key]: state[key].filter(value => value !== domain)}));
      item.append(label, button); list.append(item);
    }
    if (!state[key].length) { const item = document.createElement('li'); item.className = 'empty'; item.textContent = 'No sites added.'; list.append(item); }
  }
}
function showResponse(response) {
  if (!response?.ok) throw new Error(response?.error || 'Still could not contact its rules service.');
  state = response.settings;
  render();
  if (response.error) status('Rules need attention: ' + response.error, true);
  else status('Local rules are active. Adult-domain list ' + (response.adultEnabled ? 'on.' : 'off.'));
}
async function save(next) {
  if (busy) return false;
  setBusy(true);
  try { showResponse(await chrome.runtime.sendMessage({type: 'save', settings: next})); return true; }
  catch (error) { status('Changes were not saved: ' + error.message, true); render(); return false; }
  finally { setBusy(false); }
}
for (const [prefix, key] of [['blocked', 'blockedDomains'], ['allowed', 'allowedDomains']]) {
  $(prefix + '-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !state) return;
    try { const domain = normalize($(prefix + '-input').value); if (await save({...state, [key]: [...new Set([...state[key], domain])]})) $(prefix + '-input').value = ''; }
    catch (error) { status(error.message, true); }
  });
}
$('adult').addEventListener('change', () => save({...state, adultListEnabled: $('adult').checked}));
$('export').addEventListener('click', () => {
  if (!state) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2) + '\n'], {type: 'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'still-blocked-sites.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('import').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  pendingImport = undefined; $('import-review').hidden = true;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Import must be smaller than 1 MB.');
    pendingImport = parseImport(await file.text(), normalize);
    $('import-summary').textContent = `Replace your lists with ${pendingImport.blockedDomains.length} blocked and ${pendingImport.allowedDomains.length} allowed domains. Adult-domain list will be ${pendingImport.adultListEnabled ? 'on' : 'off'}.`;
    $('import-review').hidden = false;
  } catch (error) { status(error.message, true); }
});
$('apply-import').addEventListener('click', async () => { if (pendingImport && await save(pendingImport)) { pendingImport = undefined; $('import-review').hidden = true; } });
$('cancel-import').addEventListener('click', () => { pendingImport = undefined; $('import-review').hidden = true; });
setBusy(true);
try {
  const [psl, metadata, response] = await Promise.all([fetch('data/public_suffix_list.dat').then(r => r.text()), fetch('data/metadata.json').then(r => r.json()), chrome.runtime.sendMessage({type: 'get'})]);
  normalize = createDomainNormalizer(psl);
  $('list-info').textContent = `${metadata.domains.toLocaleString()} bundled domains · Sinfonietta list · revision ${metadata.commit.slice(0, 8)}. Updates arrive with the extension.`;
  showResponse(response); setBusy(false);
} catch (error) { status('Could not load local controls: ' + error.message, true); }
