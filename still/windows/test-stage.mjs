// Exercise the real action with isolated process/artifact service boundaries.
// This does not run Windows binaries, create archives, or contact GitHub.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../.github/actions/stage/index.js', import.meta.url), 'utf8');

function stage(options = {}) {
  const inputs = {from_artifact: false, upload_final: false, arm: false,
    package_here: false, save_artifact: true, checkpoint_id: "7",
    final_directory: "C:\\helium-windows\\verified-packages", ...options.inputs};
  const outputs = new Map();
  const commands = [];
  const removed = [];
  const patterns = [];
  const uploads = [];
  const downloads = [];
  const deleted = [];
  const warnings = [];
  const events = [];
  let waits = 0;
  const dependencies = {
    '@actions/core': {
      getBooleanInput: name => inputs[name] ?? false,
      getInput: name => inputs[name] ?? '',
      warning: message => warnings.push(message),
      setOutput: (name, value) => outputs.set(name, value),
    },
    '@actions/io': {rmRF: async target => removed.push(target)},
    '@actions/exec': {
      exec: async (command, args, config = {}) => {
        commands.push({command, args, config});
        let exit = 0;
        if (command === 'python' && args[0] === '-m') exit = options.pipExit ?? 0;
        if (command === 'python' && args[0] === 'build.py') exit = options.buildExit ?? 42;
        if (command === '7z') exit = options.zipExits?.[args[0]] ?? 0;
        if (exit !== 0 && !config.ignoreReturnCode) {
          throw new Error(`${command} ${args[0]} failed: ${exit}`);
        }
        return exit;
      },
      getExecOutput: async () => ({exitCode: 0, stdout: '0.18.1.1\n'}),
    },
    '@actions/artifact': {DefaultArtifactClient: class {
      async listArtifacts() {
        if (options.cleanupFailure) throw new Error('Artifact listing unavailable');
        return {artifacts: [{id: 7, name: 'build-artifact-x86_64-previous'}]};
      }
      async downloadArtifact(...args) { downloads.push(args); }
      async deleteArtifact(name) { deleted.push(name); events.push(['delete', name]); }
      async uploadArtifact(...args) {
        uploads.push(args);
        if (uploads.length <= (options.uploadFailures ?? 0)) {
          throw new Error('Artifact service unavailable');
        }
        events.push(['uploaded', args[0]]);
        return {id: 42};
      }
    }},
    '@actions/glob': {create: async pattern => {
      patterns.push(pattern);
      return {glob: async () => options.packages ?? ['still_0.18.1.1_x64-windows.zip']};
    }},
    crypto: {randomUUID: () => 'fresh-stage-id'},
    path: path.win32,
    os: {availableParallelism: () => 4, freemem: () => 16 * 1024 ** 3},
  };
  const module = {exports: {}};
  vm.runInNewContext(source, {
    module,
    require: name => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`);
      return dependencies[name];
    },
    console: {log() {}, error() {}},
    process: {env: {RUNNER_ENVIRONMENT: 'github-hosted'}, on() {}},
    setTimeout: callback => { waits++; queueMicrotask(callback); },
  });
  return {run: module.exports.run, outputs, commands, removed, patterns, uploads,
    downloads, deleted, warnings, events,
    waits: () => waits};
}

test('failed archive creation cannot replace the previous checkpoint', async () => {
  const action = stage({zipExits: {a: 2}});
  await assert.rejects(action.run(), /7z a failed: 2/);
  assert.equal(action.uploads.length, 0);
  assert.equal(action.outputs.has('artifact_id'), false);
});

test('archive integrity failure prevents checkpoint upload', async () => {
  const action = stage({zipExits: {t: 2}});
  await assert.rejects(action.run(), /7z t failed: 2/);
  assert.equal(action.uploads.length, 0);
});

test('exhausted checkpoint upload retries fail the action', async () => {
  const action = stage({inputs: {from_artifact: true}, uploadFailures: 5});
  await assert.rejects(action.run(), /Artifact service unavailable/);
  assert.equal(action.uploads.length, 5);
  assert.equal(action.waits(), 4);
  assert.equal(action.deleted.length, 4);
  assert.ok(action.deleted.every(name => name === 'build-artifact-x86_64-fresh-stage-id'));
  assert.equal(action.deleted.includes('build-artifact-x86_64-previous'), false);
  assert.equal(action.outputs.has('artifact_id'), false);
});

test('a transient upload failure can recover with a verified fresh checkpoint', async () => {
  const action = stage({uploadFailures: 2});
  await action.run();
  assert.equal(action.uploads.length, 3);
  assert.equal(action.outputs.get('artifact_id'), 42);
  assert.equal(action.outputs.get('finished'), false);
  assert.equal(action.waits(), 2);
  assert.equal(action.removed.length, 1);
  assert.match(action.removed[0], /artifacts\.zip$/);
  assert.deepEqual(action.commands.filter(item => item.command === '7z')
    .map(item => item.args[0]), ['a', 't']);
});

test('dependency setup failure stops before compilation', async () => {
  const action = stage({pipExit: 1});
  await assert.rejects(action.run(), /python -m failed: 1/);
  assert.equal(action.commands.some(item => item.args[0] === 'build.py'), false);
  assert.equal(action.uploads.length, 0);
});

test('a corrupt restored archive stops before compilation', async () => {
  const action = stage({inputs: {from_artifact: true}, zipExits: {x: 2}});
  await assert.rejects(action.run(), /7z x failed: 2/);
  assert.equal(action.commands.some(item => item.command === 'python'), false);
});

test('only successful compilation or the explicit checkpoint code can continue', async () => {
  for (const buildExit of [1, -1]) {
    const action = stage({buildExit});
    await assert.rejects(action.run(), /Unexpected return code/);
    assert.equal(action.uploads.length, 0);
  }
  const action = stage({buildExit: 0, inputs: {package_here: true}});
  await action.run();
  assert.equal(action.outputs.get('finished'), true);
  assert.equal(action.outputs.get('package_here'), true);
  assert.equal(action.uploads.length, 0);
});

test('final upload finds Still filenames and rejects empty package selections', async () => {
  const missing = stage({inputs: {upload_final: true}, packages: []});
  await assert.rejects(missing.run(), /No verified Still packages/);
  assert.equal(missing.uploads.length, 0);
  const found = stage({inputs: {upload_final: true}});
  await found.run();
  assert.match(found.patterns[0], /still_\*$/);
  assert.equal(found.uploads.length, 1);
  assert.equal(found.outputs.get('finished'), true);
  assert.equal(found.outputs.get('version'), '0.18.1.1');
});


test('resume uses the exact previous ID and replaces it only after successful upload', async () => {
  const action = stage({inputs: {from_artifact: true}, uploadFailures: 1});
  await action.run();
  assert.equal(action.downloads[0][0], 7);
  assert.equal(action.outputs.get('artifact_id'), 42);
  assert.deepEqual(action.events, [
    ['delete', 'build-artifact-x86_64-fresh-stage-id'],
    ['uploaded', 'build-artifact-x86_64-fresh-stage-id'],
    ['delete', 'build-artifact-x86_64-previous'],
  ]);
});

test('invalid checkpoint IDs stop before restore or compilation', async () => {
  for (const checkpoint_id of ['', '0', '-1', 'NaN', '7suffix', '9007199254740992']) {
    const action = stage({inputs: {from_artifact: true, checkpoint_id}});
    await assert.rejects(action.run(), /valid checkpoint_id/);
    assert.equal(action.downloads.length, 0);
    assert.equal(action.commands.length, 0);
  }
});

test('old-checkpoint cleanup failure does not discard a valid replacement', async () => {
  const action = stage({inputs: {from_artifact: true}, cleanupFailure: true});
  await action.run();
  assert.equal(action.outputs.get('artifact_id'), 42);
  assert.equal(action.warnings.length, 1);
  assert.equal(action.deleted.length, 0);
});
