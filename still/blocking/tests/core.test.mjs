import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createDomainNormalizer, validateSettings, parseImport, customRules, matchesDomain, DEFAULT_SETTINGS} from '../extension/core.mjs';
const psl = await readFile(new URL('../extension/data/public_suffix_list.dat', import.meta.url), 'utf8');
const normalize = createDomainNormalizer(psl);
test('domain normalization preserves host boundaries and IDNA', () => {
  assert.equal(normalize(' HTTPS://BÜCHER.DE/path?q=hello '), 'xn--bcher-kva.de');
  assert.equal(normalize('WWW.Example.COM.'), 'www.example.com');
  assert.equal(normalize('a.city.kawasaki.jp'), 'a.city.kawasaki.jp');
  assert.equal(normalize('www.ck'), 'www.ck');
  assert.equal(normalize('a.github.io'), 'a.github.io');
  for (const value of ['com', 'co.uk', 'github.io', 'kawasaki.jp', 'foo.kawasaki.jp', 'a.ck', '*.example.com', 'example.com\\@evil.com', 'a@b.com', 'https://x:y@example.com', '127.1', '2130706433', '0x7f000001', '[::1]', 'example.com:8080', 'file:///tmp/file', '-a.com', 'a..com', '%65xample.com', 'a b.com']) assert.throws(() => normalize(value), undefined, value);
});
test('explicit allow rules have higher priority and exact domain boundaries', () => {
  const settings = validateSettings({...DEFAULT_SETTINGS, blockedDomains: ['example.com'], allowedDomains: ['docs.example.com']}, normalize);
  const rules = customRules(settings);
  const matching = host => rules.filter(rule => rule.condition.requestDomains.some(domain => matchesDomain(host, domain))).sort((a, b) => b.priority - a.priority)[0]?.action.type;
  assert.equal(matching('example.com'), 'block');
  assert.equal(matching('sub.example.com'), 'block');
  assert.equal(matching('docs.example.com'), 'allow');
  assert.equal(matching('deep.docs.example.com'), 'allow');
  assert.equal(matching('notexample.com'), undefined);
  assert.equal(matching('example.company'), undefined);
  assert.equal(matching('example.com.evil.org'), undefined);
  assert(rules.every(rule => rule.condition.resourceTypes.join(',') === 'main_frame,sub_frame'));
});
test('strict import is bounded, canonical, deduplicated and round-trips', () => {
  const input = {...DEFAULT_SETTINGS, blockedDomains: ['BÜCHER.DE', 'xn--bcher-kva.de', 'EXAMPLE.COM'], allowedDomains: ['docs.example.com']};
  const result = parseImport(JSON.stringify(input), normalize);
  assert.deepEqual(result.blockedDomains, ['example.com', 'xn--bcher-kva.de']);
  assert.deepEqual(parseImport(JSON.stringify(result), normalize), result);
  for (const input of ['{', '[]', JSON.stringify({...DEFAULT_SETTINGS, version: 2}), JSON.stringify({...DEFAULT_SETTINGS, adultListEnabled: 'false'}), JSON.stringify({...DEFAULT_SETTINGS, extra: true}), JSON.stringify({...DEFAULT_SETTINGS, blockedDomains: ['com']}), JSON.stringify({...DEFAULT_SETTINGS, allowedDomains: [null]}), JSON.stringify({...DEFAULT_SETTINGS, blockedDomains: Array(5001).fill('example.com')}), ' '.repeat(1024 * 1024 + 1)]) assert.throws(() => parseImport(input, normalize));
});
test('all bundled domains validate and static rules remain below guaranteed budget', async () => {
  const root = new URL('../extension/data/', import.meta.url);
  const rules = JSON.parse(await readFile(new URL('adult-rules.json', root)));
  const metadata = JSON.parse(await readFile(new URL('metadata.json', root)));
  const domains = rules.flatMap(rule => rule.condition.requestDomains);
  assert.equal(domains.length, metadata.domains);
  assert.equal(new Set(domains).size, domains.length);
  assert(rules.length < 30000);
  assert(rules.every(rule => rule.priority === 100 && rule.action.type === 'block'));
  for (const domain of domains) assert.equal(normalize(domain), domain);
  const hosts = await readFile(new URL('pornography-hosts', root));
  assert.equal(createHash('sha256').update(hosts).digest('hex'), metadata.sha256);
  assert.equal(createHash('sha256').update(psl).digest('hex'), metadata.publicSuffixSha256);
});
test('maximum custom settings stay under dynamic-rule budget with unique IDs', () => {
  const settings = {...DEFAULT_SETTINGS, blockedDomains: Array.from({length: 5000}, (_, n) => `b${n}.example.com`), allowedDomains: Array.from({length: 5000}, (_, n) => `a${n}.example.com`)};
  const rules = customRules(settings);
  assert.equal(rules.length, 20);
  assert.equal(new Set(rules.map(rule => rule.id)).size, 20);
});
