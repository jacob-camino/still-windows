#!/usr/bin/env python3
"""Check a prepared, Still-patched source tree without claiming a Windows build."""

import argparse
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
arguments, remaining = parser.parse_known_args()
SOURCE = arguments.source.resolve()
sys.argv = [sys.argv[0], *remaining]
sys.path.insert(0, str(ROOT / 'helium-chromium/utils'))
import filescfg


def load_tool(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cxx_guid(text, field):
    initializer = re.search(r'\.' + field + r' = (\{.*?\}\})', text, re.S)[1]
    numbers = [int(value, 16) for value in re.findall(r'0x[0-9a-fA-F]+', initializer)]
    return uuid.UUID(fields=(*numbers[:3], numbers[3], numbers[4],
                             int.from_bytes(bytes(numbers[5:]), 'big')))


class IntegrationTests(unittest.TestCase):
    def test_install_and_service_identities_agree(self):
        namespace = uuid.uuid5(uuid.NAMESPACE_DNS, 'com.jacobcamino.still.windows')
        install = (SOURCE / 'chrome/install_static/chromium_install_modes.h').read_text()
        installer = (ROOT / 'installer/helium.nsi').read_text()
        for field in ('toast_activator_clsid', 'elevator_clsid', 'elevator_iid',
                      'tracing_service_clsid', 'tracing_service_iid'):
            name = 'toast_activator' if field == 'toast_activator_clsid' else field
            self.assertEqual(cxx_guid(install, field), uuid.uuid5(namespace, name))
        app_id = '{' + str(uuid.uuid5(namespace, 'app')).upper() + '}'
        self.assertIn('L"' + app_id + '"', install)
        self.assertIn('!define PRODUCT_GUID "' + app_id + '"', installer)
        self.assertIn('kCompanyPathName[] = L"JacobCamino"', install)
        self.assertIn('kProductPathName[] = L"Still"', install)
        self.assertIn('!define PRODUCT_COMPANY_PATH "JacobCamino"', installer)
        for field, path, interface in (
            ('elevator_iid', 'chrome/elevation_service/elevation_service_idl.idl',
             'IElevator2Chromium'),
            ('tracing_service_iid',
             'chrome/windows_services/elevated_tracing_service/tracing_service_idl.idl',
             'ISystemTraceSessionChromium'),
        ):
            text = (SOURCE / path).read_text()
            actual = re.search(r'uuid\(([0-9A-F-]+)\),\s*helpstring\("' + interface,
                               text)[1]
            self.assertEqual(uuid.UUID(actual), cxx_guid(install, field))
        self.assertIn('.old_tracing_service_iids = {}', install)

    def test_both_packagers_retain_exact_signed_crx(self):
        package = ROOT / 'still/blocking/package/still-blocking.crx'
        archive_tool = load_tool(SOURCE / 'chrome/tools/build/win/create_installer_archive.py')
        archive_tool.options = SimpleNamespace(use_static_angle='False')
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            output = temporary / 'output'
            (output / 'resources').mkdir(parents=True)
            shutil.copyfile(package, output / 'resources/still-blocking.crx')
            for arch in ('64bit', 'arm'):
                files = list(filescfg.filescfg_generator(
                    SOURCE / 'chrome/tools/build/win/FILES.cfg', output, arch))
                self.assertEqual(files, [Path('resources/still-blocking.crx')])
                archive = temporary / f'still-test-{arch}.zip'
                filescfg.create_archive(files, (), output, archive)
                with zipfile.ZipFile(archive) as zipped:
                    self.assertEqual(zipped.read(archive.stem + '/resources/still-blocking.crx'),
                                     package.read_bytes())
            config = archive_tool.Readconfig(
                SOURCE / 'chrome/installer/mini_installer/chrome.release', '154.0.8037.57')
            staged = temporary / 'staged'
            archive_tool.CopySectionFilesToStagingDir(
                config, 'GENERAL', str(staged), str(output), False)
            installed = staged / 'Helium-bin/154.0.8037.57/resources/still-blocking.crx'
            self.assertEqual(installed.read_bytes(), package.read_bytes())

    def test_tampered_bundle_stops_before_staging(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            shutil.copyfile(ROOT / 'still/blocking/copy-into-source.py', temporary / 'validate.py')
            (temporary / 'package').mkdir()
            shutil.copyfile(ROOT / 'still/blocking/package/metadata.json',
                            temporary / 'package/metadata.json')
            (temporary / 'package/still-blocking.crx').write_bytes(b'corrupted')
            result = subprocess.run([sys.executable, str(temporary / 'validate.py'),
                                     '--source', str(SOURCE), '--check-only'],
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('CRX hash/size does not match', result.stderr)

    def test_packaging_rejects_missing_or_stale_built_blocker(self):
        package = load_tool(ROOT / 'package.py')
        package._BUILD_SRC = SOURCE
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            output = temporary / 'output'
            output.mkdir()
            release = temporary / 'release'
            with self.assertRaisesRegex(FileNotFoundError, 'Missing Still blocker'):
                package.create_packages(output, release)
            self.assertFalse(release.exists())
            resources = output / 'resources'
            resources.mkdir()
            artifact = resources / 'still-blocking.crx'
            artifact.write_bytes(b'old or incomplete build')
            with self.assertRaisesRegex(ValueError, 'differs from the reviewed package'):
                list(package.portable_files(output))
            shutil.copyfile(ROOT / 'still/blocking/package/still-blocking.crx', artifact)
            self.assertEqual(list(package.portable_files(output)),
                             [Path('resources/still-blocking.crx')])
            package.verify_blocking_bundle(resources)

    def test_patch_application_inside_parent_git_repository(self):
        apply = load_tool(ROOT / 'still/apply.py')
        selected = {'chrome/VERSION'}
        for patch in apply.PATCHES:
            selected.update(re.findall(r'^\+\+\+ b/([^\t\n ]+)', patch.read_text(), re.M))
        (ROOT / 'build').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT / 'build') as temporary:
            source = Path(temporary)
            for name in selected:
                destination = source / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(SOURCE / name, destination)
            environment = dict(os.environ, GIT_CEILING_DIRECTORIES=str(source.parent))
            for patch in reversed(apply.PATCHES):
                subprocess.run(['git', '-C', str(source), 'apply', '--reverse', str(patch)],
                               env=environment, check=True, capture_output=True)
            command = [sys.executable, str(ROOT / 'still/apply.py'), '--source', str(source)]
            checked = subprocess.run([*command, '--check-only'], check=True,
                                     capture_output=True, text=True)
            self.assertIn(f'{len(apply.PATCHES)} pending', checked.stdout)
            subprocess.run(command, check=True, capture_output=True)
            installed = source / 'chrome/browser/extensions/still_blocking/still-blocking.crx'
            self.assertEqual(installed.read_bytes(),
                             (ROOT / 'still/blocking/package/still-blocking.crx').read_bytes())
            checked = subprocess.run([*command, '--check-only'], check=True,
                                     capture_output=True, text=True)
            self.assertIn('0 pending', checked.stdout)
            self.assertIn('kProductPathName[] = L"Still"',
                          (source / 'chrome/install_static/chromium_install_modes.h').read_text())


if __name__ == '__main__':
    unittest.main()
