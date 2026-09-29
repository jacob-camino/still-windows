# Still local blocked sites

Independent Manifest V3 extension. It does not modify Helium, uBlock, TLS,
certificate checking, CORS, site isolation, sandboxing, or page security policy.
Native integration is provided by `../patches/003-local-blocking.patch`. The
ordinary extension has been runtime-tested separately; the native preinstall
path still needs validation in a completed Still browser build.

Run `npm run build` then `npm test` in this directory. Node 22+ is sufficient;
there are no npm dependencies or remote runtime assets. Load the `extension/`
directory through `chrome://extensions` → Developer mode → Load unpacked in
Helium or Chromium. Open extension details → Extension options, or its toolbar
action, for the Ink settings page. No command-line security flags are needed.

## Bundled installation

`package/still-blocking.crx` is signed CRX3 with the stable public identity
`acckjhcnbonppllgbaknbacfekcoeikp`. The private signing key is kept outside this
repository and is never included in the extension or application. To rebuild
after changes, run `node package-crx.mjs --browser /path/to/chromium --key
/private/path/blocking.pem`; use `--initialize-key` only when creating a separate
new fork identity. Existing identities reject a different signing key.

Before applying patch 003 and generating GN, the source preparation owner runs:

```
python3 still/blocking/copy-into-source.py --source /path/to/chromium/source
```

The helper verifies the package hash, manifest identity/version/permissions,
and exact packaged contents against the extension sources. It copies only the
signed CRX and public identity header into the browser source tree. Patch 003
places the CRX in macOS framework Resources, or `out/.../resources` for Windows
and Linux. Those platforms' eventual installer/archive scripts must retain the
resource file as well.

The native loader uses Chromium's existing regular CRX installer with normal
extension permissions, never the privileged component-extension path. It
follows Chromium's existing eligible-new-profile preinstall decision and offers
bundled version updates only while the extension remains installed. It respects
removal and ordinary extension disable controls; existing profiles without this
extension do not silently acquire it. The standard installer checks signatures,
expected ID/version, and permissions. No verifier or permission checks change.
The usual extension action/options page opens the centralized settings.

For an actual browser test, set `STILL_CHROMIUM` to a Chromium or Chrome for
Testing executable and run `npm run test:runtime`. It uses an isolated temporary
profile, opens no adult websites, and leaves the user's browser/profile alone.
Verified with cached Chrome for Testing 151 on Apple Silicon: MV3 loading, all
123 static rules, settings page initialization, real DNR block/allow precedence,
adult list toggle, invalid-input preservation, rollback after a simulated
storage failure, and a real blocked navigation.
The unit tests additionally validate every bundled domain, IDNA, PSL wildcards
and exceptions, deceptive domain suffixes, import bounds/schema, and quotas.

All matching occurs on device. A pinned adult-domain list ships as static DNR
rules. User block rules and allow exceptions use dynamic DNR rules, stored in
`chrome.storage.local`. Allow entries override all Still block entries. They do
not override uBlock or the browser's security protections. Rules apply to HTTP(S)
top-level and frame navigations, including subdomains. Other resource types,
other browsers, and private windows are outside this extension's coverage.
Blocked navigation currently uses Chromium's standard blocked-by-client page.

Public suffixes (including private suffixes such as github.io), IP addresses,
wildcards and malformed entries are rejected. IDNA hosts normalize to ASCII.
Pasting an HTTP(S) URL adds its host, not a path-specific rule. Each user list
allows 5,000 domains. Import accepts only the versioned exported JSON schema,
up to 1 MiB, and requires a replacement confirmation in the settings page.
Updates are serialized; a failed update attempts to restore previous rules and
reports an error. On service worker restart, saved settings are reapplied.

The bundled list is a starting point, not complete detection. It may miss sites
or block appropriate material; local allow exceptions are available. A model is
not bundled or running. The text-detection settings entry explicitly says “Not
installed.” There are no content scripts, page text/image access, remote fetches,
telemetry, or model downloads. A future optional local text classifier should
distinguish pornographic intent from medical/educational discussion and must be
evaluated before activation; it must not permanently auto-ban domains based on
a page result.

## Source provenance

- `extension/data/pornography-hosts` is the original Sinfonietta list at
  `46f3097d7bcfc9eea323fe365074dfd771d0d17c`, MIT. Source:
  https://github.com/Sinfonietta/hostfiles/tree/46f3097d7bcfc9eea323fe365074dfd771d0d17c
- `extension/data/public_suffix_list.dat` is unmodified publicsuffix/list at
  `a179a48c465e818cfd8d626691cb317985da87fb`, MPL-2.0. Source:
  https://github.com/publicsuffix/list/tree/a179a48c465e818cfd8d626691cb317985da87fb
- Exact original-data hashes, generated domain/rule counts, and rejected entries
  are in `extension/data/metadata.json`. License texts and user-visible
  attribution ship inside `extension/licenses/` and `licenses.html`.
- Still extension code follows this repository's GPL-3.0-only license.

`build.mjs` normalizes/deduplicates the pinned list and groups up to 500 domains
per DNR rule. The result uses 123 rules for 61,154 domains, well below the 30,000
guaranteed static rule budget. List updates require a deliberate source revision,
license/provenance review, rebuild, tests, and extension update. Nothing fetches
list updates during browsing.

Chromium's [DNR API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
provides local static/dynamic rules and per-extension priority. Its
[extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
is left strict: only packaged code/assets, no eval/WASM exception or external
connect permission. Host-content permissions are unnecessary for these rules.
