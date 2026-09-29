#!/usr/bin/env python3
"""Validate the signed package against reviewed sources, then stage build assets."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import struct
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path, help='Prepared Chromium source tree')
parser.add_argument('--check-only', action='store_true', help='Validate assets without writing to the source tree')
args = parser.parse_args()
root = Path(__file__).resolve().parent
source = args.source.resolve()
if not (source / 'chrome/browser/extensions/external_provider_impl.cc').is_file():
    raise SystemExit('Expected a prepared Chromium source tree.')
metadata = json.loads((root / 'package/metadata.json').read_text())
crx = (root / 'package/still-blocking.crx').read_bytes()
if hashlib.sha256(crx).hexdigest() != metadata['sha256'] or len(crx) != metadata['bytes']:
    raise SystemExit('CRX hash/size does not match its package metadata.')
if len(crx) < 12 or crx[:4] != b'Cr24' or struct.unpack_from('<I', crx, 4)[0] != 3:
    raise SystemExit('Expected a signed CRX3 package.')
manifest = json.loads((root / 'extension/manifest.json').read_text())
key = base64.b64decode(metadata['publicKey'], validate=True)
extension_id = ''.join(chr(97 + int(n, 16)) for n in hashlib.sha256(key).hexdigest()[:32])
if extension_id != metadata['id'] or manifest.get('key') != metadata['publicKey'] or manifest['version'] != metadata['version']:
    raise SystemExit('Manifest and package identity/version disagree.')
if manifest['permissions'] != ['storage', 'declarativeNetRequest'] or 'host_permissions' in manifest or 'content_scripts' in manifest:
    raise SystemExit('Unexpected permission expansion; review packaging policy first.')
expected = {}
for path in (root / 'extension').rglob('*'):
    relative = path.relative_to(root / 'extension')
    if '_metadata' in relative.parts or not path.is_file():
        continue
    if path.is_symlink():
        raise SystemExit('Symlinks are not allowed in extension assets.')
    expected[relative.as_posix()] = path.read_bytes()
zip_offset = 12 + struct.unpack_from('<I', crx, 8)[0]
with zipfile.ZipFile(io.BytesIO(crx[zip_offset:])) as archive:
    actual = {entry.filename: archive.read(entry) for entry in archive.infolist() if not entry.is_dir()}
if actual != expected:
    raise SystemExit('CRX contents differ from extension sources. Rebuild/sign before staging.')
header = (root / 'package/identity.h').read_text()
if f'"{extension_id}"' not in header or f'"{manifest["version"]}"' not in header:
    raise SystemExit('Generated native identity header is stale.')
if args.check_only:
    print(f'Validated {extension_id} v{manifest["version"]}; SHA-256 {metadata["sha256"]}')
    raise SystemExit(0)
destination = source / 'chrome/browser/extensions/still_blocking'
destination.mkdir(parents=True, exist_ok=True)
for name in ('identity.h', 'still-blocking.crx'):
    temporary = destination / (name + '.tmp')
    shutil.copyfile(root / 'package' / name, temporary)
    temporary.replace(destination / name)
print(f'Staged {extension_id} v{manifest["version"]}; SHA-256 {metadata["sha256"]}')
