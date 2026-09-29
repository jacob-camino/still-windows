const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const {DefaultArtifactClient} = require('@actions/artifact');
const glob = require('@actions/glob');

const path = require('path');
const os = require('os');
const {randomUUID} = require('crypto');

async function run() {
    const started_at = Number(process.env.HELIUM_JOB_STARTED_AT) || Math.floor(Date.now() / 1000);

    process.on('SIGINT', function() {
    })
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    const upload_final = core.getBooleanInput('upload_final', {required: false});

    const arm = core.getBooleanInput('arm', {required: false})
    console.log(`artifact: ${from_artifact}, upload_final: ${upload_final}`);

    const artifact = new DefaultArtifactClient();
    const artifactPrefix = arm ? 'build-artifact-arm64' : 'build-artifact-x86_64';
    let previousArtifactId;
    if (from_artifact && !upload_final) {
        const checkpointId = core.getInput('checkpoint_id', {required: true});
        previousArtifactId = Number(checkpointId);
        if (!/^\d+$/.test(checkpointId) ||
            !Number.isSafeInteger(previousArtifactId) || previousArtifactId <= 0) {
            throw new Error('A valid checkpoint_id is required to resume a build');
        }
        await artifact.downloadArtifact(previousArtifactId, {path: 'C:\\helium-windows\\build'});
        await exec.exec('7z', ['x', 'C:\\helium-windows\\build\\artifacts.zip',
            '-oC:\\helium-windows\\build', '-y']);
        await io.rmRF('C:\\helium-windows\\build\\artifacts.zip');
    }

    const args = ['build.py', '--ci', String(started_at)]
    if (process.env.HELIUM_BUILD_JOBS) {
        args.push('-j', process.env.HELIUM_BUILD_JOBS);
    } else if (process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
        const jobs = Math.max(1, Math.min(os.availableParallelism(),
            Math.floor(os.freemem() / (3 * 1024 ** 3))));
        args.push('-j', String(jobs));
    }

    if (arm)
        args.push('--arm')

    if (upload_final) {
        const finalDirectory = core.getInput('final_directory', {required: true});
        const globber = await glob.create(path.join(finalDirectory, 'still_*'),
            {matchDirectories: false});
        const packageList = await globber.glob();
        if (packageList.length === 0) {
            throw new Error('No verified Still packages found to upload');
        }
        const finalArtifactName = arm ? 'helium-arm64' : 'helium-x86_64';
        const maxUploadAttempts = 5;
        for (let attempt = 1; attempt <= maxUploadAttempts; ++attempt) {
            try {
                await artifact.deleteArtifact(finalArtifactName);
            } catch (e) {
                // ignored
            }
            try {
                await artifact.uploadArtifact(finalArtifactName, packageList,
                    finalDirectory, { retentionDays: 4, compressionLevel: 0 });
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                if (attempt === maxUploadAttempts) throw e;
                // Wait 10 seconds between the attempts
                await new Promise(r => setTimeout(r, 10000));
            }
        }

        const { exitCode, stdout } = await exec.getExecOutput('python', [
            'helium-chromium\\utils\\helium_version.py',
            '--print',
            '--tree', 'helium-chromium',
            '--platform-tree', '.'
        ]);

        if (exitCode !== 0) throw new Error(`Failed getting version: ${exitCode}`);
        core.setOutput('version', stdout.trim());
        core.setOutput('finished', true);
        return;
    }

    await exec.exec('python', ['-m', 'pip', 'install', 'httplib2==0.22.0', 'Pillow', 'clang-format'], {
        cwd: 'C:\\helium-windows'
    });
    const retCode = await exec.exec('python', args, {
        cwd: 'C:\\helium-windows',
        ignoreReturnCode: true
    });

    if (retCode !== 0 && retCode !== 42) {
        throw new Error(`Unexpected return code: ${retCode}`);
    }

    core.setOutput('finished', retCode === 0);

    const package_here = retCode === 0 && core.getBooleanInput('package_here') &&
        Date.now() / 1000 - started_at < 5 * 60 * 60;
    core.setOutput('package_here', package_here);

    if (!package_here && core.getBooleanInput('save_artifact')) {
        // A checkpoint must be a fresh, complete archive before replacing the
        // previous uploaded tree. Never continue after 7-Zip reports failure.
        await io.rmRF('C:\\helium-windows\\artifacts.zip');
        await exec.exec('7z', ['a', '-tzip', 'C:\\helium-windows\\artifacts.zip',
            'C:\\helium-windows\\build\\src', '-mx=3', '-mtc=on']);
        await exec.exec('7z', ['t', 'C:\\helium-windows\\artifacts.zip']);
        // Retry only this new name; a failed upload must leave the previous
        // stage's checkpoint available for a rerun.
        const artifactName = `${artifactPrefix}-${randomUUID()}`;
        for (let i = 0; i < 5; ++i) {
            if (i > 0) {
                try {
                    await artifact.deleteArtifact(artifactName);
                } catch (e) {
                    // A failed upload may not have created an artifact.
                }
            }
            try {
                const uploaded = await artifact.uploadArtifact(artifactName, ['C:\\helium-windows\\artifacts.zip'],
                    'C:\\helium-windows', { retentionDays: 4, compressionLevel: 0 });
                core.setOutput('artifact_id', uploaded.id);
                if (previousArtifactId) {
                    try {
                        const {artifacts} = await artifact.listArtifacts();
                        const previous = artifacts.find(item => item.id === previousArtifactId);
                        if (previous) await artifact.deleteArtifact(previous.name);
                    } catch (e) {
                        // The new checkpoint is valid; retention bounds an old
                        // checkpoint if best-effort cleanup is unavailable.
                        core.warning(`Previous checkpoint cleanup failed: ${e}`);
                    }
                }
                break;
            } catch (e) {
                console.error(`Upload artifact failed: ${e}`);
                if (i === 4) throw e;
                // Wait 10 seconds between the attempts
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }
}

if (require.main === module) {
    run().catch(err => core.setFailed(err?.message ?? String(err)));
}

module.exports = {run};
