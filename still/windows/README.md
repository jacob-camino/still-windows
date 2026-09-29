# Still Windows integration

This personal fork adds the shared Still UI, a separate Windows product identity,
and the same signed local blocking extension as the Mac build. No Windows binary,
installer, Authenticode signature, or working update feed has been produced or
tested yet. No CI workflow or paid build host has been started.

The pinned base is Helium Chromium `b38c4bdd2ecbe5c680dc3c5d464a2edc84d49d4c`,
Chromium `154.0.8037.57`. `build.py` runs `still/apply.py` after upstream patches,
domain/name substitutions, and resource preparation. The helper checks the
pinned version, validates the signed blocker against its reviewed sources,
checks the complete pending patch series, and applies it idempotently. It also
works for extracted source trees nested inside this packaging repository.

## Identity

Still uses `JacobCamino\Still` for installation and profile paths. The default
profile is `%LOCALAPPDATA%\JacobCamino\Still\User Data`; installations use the
`Application` subdirectory under either local application data or Program Files.
The application ID is `Still`, document ProgIDs use `StillHTM` and `StillPDF`,
and the direct launch URL scheme is `still:`. The NSIS installer uses the same
company/product path and application GUID as the native installer.

Install, Active Setup, toast, elevator, and tracing service identifiers are
deterministic UUIDv5 values. Generate their namespace with
`uuid5(NAMESPACE_DNS, "com.jacobcamino.still.windows")`, then call `uuid5` with
`app`, `active_setup`, `toast_activator`, `elevator_clsid`, `elevator_iid`,
`legacy_elevator_iid`, `elevator_lib`, `tracing_service_clsid`,
`tracing_service_iid`, or `tracing_service_lib`. The native install constants
and corresponding IDL interface IDs agree. Still has no old Chromium or Helium
COM identities to migrate or remove.

Internal `chrome.exe`, `helium.7z`, `Helium-bin`, and updater helper filenames
remain compatible with upstream packaging. Retaining `chrome.exe` also retains
Windows' shared `App Paths\chrome.exe` launcher registration; it is not complete
registry isolation from other Chromium forks. Profile paths, document handlers,
application IDs, and registered service identities are separate. Copyrights,
upstream service names, translated prose, and existing icon assets are retained.

## Build and package

Use a native Windows build host with the prerequisites from the root README.
The initial build must run Windows MIDL to regenerate the changed interface
identifiers; non-Windows cross-compilation using cached MIDL outputs has not been
prepared or validated.

```powershell
python build.py -j 8
python still/windows/test-integration.py --source build/src
python package.py --output-dir build
```

The package command uses the existing unsigned local packaging path. Add
`--arm` to `build.py` for the upstream ARM64 target. Actual x64/ARM64 compilation,
installation, first-profile extension preinstallation, default-browser
registration, browser UI behavior, and uninstall/coexistence still require
Windows runtime testing.

User-facing outputs are `still_<version>_<arch>-installer.exe`,
`still_<version>_<arch>-mini-installer.exe`, and
`still_<version>_<arch>-windows.zip`. `FILES.cfg` includes
`resources/still-blocking.crx` in portable archives. The installer archive puts
it beside `chrome.dll` under `<version>\resources`, matching
`chrome::DIR_RESOURCES`; the archive target depends on its copy target.
Portable packaging and signed installer staging reject missing or stale blocker
bytes, and validate the reviewed source bundle before packaging.

## Signing and updates

`signing.py` retains upstream Authenticode signing, signature verification,
required signing inputs, and byte-for-byte package inventory checks. Only its
product descriptions and project URL change. A Still signing identity and its
credentials have not been configured or used.

WinSparkle retains its existing EdDSA, Authenticode, consent, and elevated-helper
validation. Its existing build gate requires both `WINSPARKLE_ED_KEY` and
`WINSPARKLE_AUTHENTICODE_ORG`. No signing key, verification, sandbox, policy
value, caller check, or browser security flag is weakened by the Still patches.
The fork's default browser appcast location is
`https://github.com/jacob-camino/still-windows/releases/latest/download/appcast.xml`.
That Still feed is not published. A release process must supply matching signed
Still packages and an authenticated appcast before automatic updates can be
claimed to work. Component/service update behavior remains upstream's.

## Checks performed on macOS

The four Still patches pass checks and application against a fixture generated
from the exact Chromium revision and ordered matching Helium core/Windows
patches, including name substitution. Five integration tests cover matching
native/NSIS/IDL identities, real portable ZIP and installer staging of the exact
CRX bytes, missing/stale build output and tampered-package rejection, and patch application plus repeated
validation from inside an outer Git repository. The copied blocker's core tests
and Python syntax checks also pass. These are source/packaging checks, not a
Windows compile, installation test, or release artifact.
