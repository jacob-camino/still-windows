# Windows native build capacity

The [free-runner probe on September 29, 2026](https://github.com/jacob-camino/still-windows/actions/runs/36614575351)
measured 32.2 GiB free on a 149.4 GiB system volume, 16 GiB RAM, and four CPUs.
The `windows-2025-vs2026` image supplies Visual Studio 2026, but only the
10.0.26100.0 SDK include directory was present. The pinned Chromium source
requires Visual Studio 2026 and the newer 28000 SDK supported by the existing
environment preparation helper.

This image does not meet Chromium's documented 100 GB free-disk minimum.
Existing checkpoints store the full source/output tree beside `artifacts.zip`
on `C:`; they address job timeout, not disk or linker memory. No native build
was launched, and no paid resource was provisioned.

A practical candidate is a dedicated native Windows host with at least
8 CPUs, 32 GB RAM, and 300 GB SSD. For a first official PGO/LTO build,
16 CPUs, 64 GB RAM, and 600 GB SSD provides more headroom. These are engineering
recommendations rather than measured Still requirements. An existing suitably
equipped machine would avoid a new paid service.

GitHub's listed larger Windows runners cost $0.042/minute for 8 CPUs
($2.52/hour), or $0.082/minute for 16 CPUs ($4.92/hour). They require a
Team/Enterprise organization and are paid even for public repositories; these
personal forks do not establish that capacity. Six hours on the 16-CPU machine
would be $29.52, which is a bounded example, not a complete-build estimate.
Additional stages and setup time add cost. Paid compute requires approval.

The inherited release workflow additionally requires Azure signing credentials.
For initial test artifacts on a suitable machine, the documented `build.py`
and unsigned `package.py` path can be used. Do not remove signature verification
or supply false signing settings to make the release workflow run. The Windows
checkpoint helper now rejects failed archive creation/integrity checks and
exhausted upload retries. Each stage passes the exact checkpoint ID to its
successor, and only deletes its predecessor after the new upload succeeds.
Eleven isolated action tests exercise those failures, exact-ID restore,
successful retry, cleanup failure, dependency setup, and Still package names.
A failed best-effort cleanup leaves the prior checkpoint until its existing
four-day retention expires. Artifact storage costs require a separate review
before dispatch, even when runner compute is free.
This is not a native Windows test or a completed checkpoint transfer.

- [GitHub standard runner specifications](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Larger runner sizes and availability](https://docs.github.com/en/actions/reference/runners/larger-runners)
- [Runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
- [Chromium Windows requirements](https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md)

Prices and image contents above were checked on September 29, 2026 and should
be verified before reserving capacity.
