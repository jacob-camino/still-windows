// SPDX-License-Identifier: GPL-3.0-only
export const DEFAULT_SETTINGS = Object.freeze({version: 1, adultListEnabled: true, blockedDomains: [], allowedDomains: []});
export const MAX_DOMAINS = 5000;
export const MAX_IMPORT_BYTES = 1024 * 1024;

export function createDomainNormalizer(pslText) {
  const exact = new Set(), wildcard = new Set(), exception = new Set();
  for (const line of pslText.split(/\r?\n/)) {
    const rule = line.trim();
    if (!rule || rule.startsWith('//')) continue;
    const prefix = rule.startsWith('!') ? '!' : rule.startsWith('*.') ? '*.' : '';
    const host = new URL('https://' + rule.slice(prefix.length)).hostname;
    (prefix === '!' ? exception : prefix ? wildcard : exact).add(host);
  }
  return function normalizeDomain(input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('Enter a domain or an HTTP(S) URL.');
    const value = input.trim();
    if (/[\s\\%*]/u.test(value)) throw new Error('Spaces, wildcards, escapes, and backslashes are not allowed.');
    let url;
    try { url = new URL(value.includes('://') ? value : 'https://' + value); } catch { throw new Error('Invalid domain.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Use an HTTP(S) domain without credentials or a port.');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2 || labels.some(x => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x)) || /^\d+(\.\d+)+$/.test(host)) throw new Error('Use a public website domain, not an IP address or local hostname.');
    let suffixLength = 1;
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      if (exception.has(suffix)) { suffixLength = labels.length - i - 1; break; }
      if (exact.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - i);
      if (i > 0 && wildcard.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - i + 1);
    }
    if (labels.length <= suffixLength || wildcard.has(host)) throw new Error('Enter a specific website, not a public suffix such as com, co.uk, or github.io.');
    return host;
  };
}

export function validateSettings(value, normalize) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be a JSON object.');
  const keys = ['version', 'adultListEnabled', 'blockedDomains', 'allowedDomains'];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw new Error('Unrecognized or missing settings fields.');
  if (value.version !== 1 || typeof value.adultListEnabled !== 'boolean') throw new Error('Unsupported settings format.');
  const result = {version: 1, adultListEnabled: value.adultListEnabled};
  for (const key of ['blockedDomains', 'allowedDomains']) {
    if (!Array.isArray(value[key]) || value[key].length > MAX_DOMAINS) throw new Error(`Use at most ${MAX_DOMAINS} domains per list.`);
    result[key] = [...new Set(value[key].map(normalize))].sort();
  }
  return result;
}

export function parseImport(text, normalize) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new Error('Import must be a JSON file smaller than 1 MB.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Import is not valid JSON.'); }
  return validateSettings(value, normalize);
}

export function domainRules(domains, type, priority, startId) {
  const rules = [];
  for (let i = 0; i < domains.length; i += 500) rules.push({
    id: startId + rules.length, priority, action: {type},
    condition: {requestDomains: domains.slice(i, i + 500), resourceTypes: ['main_frame', 'sub_frame'], requestMethods: ['get', 'post', 'put', 'delete', 'head', 'options', 'patch', 'connect', 'other']}
  });
  return rules;
}

export function customRules(settings) {
  return [...domainRules(settings.blockedDomains, 'block', 200, 1), ...domainRules(settings.allowedDomains, 'allow', 300, 10001)];
}

export function matchesDomain(host, domain) { return host === domain || host.endsWith('.' + domain); }
