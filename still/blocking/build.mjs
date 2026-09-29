// SPDX-License-Identifier: GPL-3.0-only
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createDomainNormalizer, domainRules} from './extension/core.mjs';
const root = new URL('./extension/', import.meta.url);
const hosts = await readFile(new URL('data/pornography-hosts', root), 'utf8');
const psl = await readFile(new URL('data/public_suffix_list.dat', root), 'utf8');
const normalize = createDomainNormalizer(psl);
const domains = new Set();
const rejected = [];
for (const line of hosts.split(/\r?\n/)) {
  const fields = line.split('#')[0].trim().split(/\s+/);
  if (!['0.0.0.0', '127.0.0.1'].includes(fields[0])) continue;
  for (const host of fields.slice(1)) {
    if (host === 'localhost') continue;
    try { domains.add(normalize(host)); } catch { rejected.push(host); }
  }
}
const sorted = [...domains].sort();
const rules = domainRules(sorted, 'block', 100, 1);
if (!domains.size || rules.length > 30000) throw new Error('Invalid packaged rule count.');
await writeFile(new URL('data/adult-rules.json', root), JSON.stringify(rules) + '\n');
const metadata = {name: 'Sinfonietta pornography-hosts', commit: '46f3097d7bcfc9eea323fe365074dfd771d0d17c', source: 'https://github.com/Sinfonietta/hostfiles', license: 'MIT', domains: domains.size, rules: rules.length, rejected, sha256: createHash('sha256').update(hosts).digest('hex'), publicSuffixCommit: 'a179a48c465e818cfd8d626691cb317985da87fb', publicSuffixSha256: createHash('sha256').update(psl).digest('hex')};
await writeFile(new URL('data/metadata.json', root), JSON.stringify(metadata, null, 2) + '\n');
console.log(`${domains.size} domains in ${rules.length} static rules; ${rejected.length} invalid/public-suffix entries excluded.`);
