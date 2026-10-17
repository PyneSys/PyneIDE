import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: ['src/env/download.ts', 'src/env/cancel.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false, outdir: 'unused',
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-download-'));
  const dest = path.join(dir, 'archive.tar.gz');
  const streams = [];
  let respond;
  let request;
  let releaseOpen;
  let notifyOpen;
  const opening = new Promise((resolve) => { notifyOpen = resolve; });
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  const mockFs = {
    ...fs,
    createWriteStream(file) {
      const stream = fs.createWriteStream(file, {
        fs: {
          ...fs,
          open(...args) {
            notifyOpen();
            void openGate.then(() => fs.open(...args));
          },
        },
      });
      streams.push(stream);
      return stream;
    },
  };
  const mockHttps = {
    get(_url, _options, callback) {
      respond = () => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { 'content-length': '4' };
        callback(response);
        return response;
      };
      request = new EventEmitter();
      request.destroy = () => request;
      return request;
    },
  };
  function load(name) {
    const module = { exports: {} };
    vm.runInNewContext(bundled.outputFiles.find((file) => path.basename(file.path) === `${name}.js`).text, {
      module, exports: module.exports,
      require: (id) => id === 'node:fs' ? mockFs : id === 'node:https' ? mockHttps : require(id),
    });
    return module.exports;
  }
  const { downloadFile } = load('download');
  const { CancelSource } = load('cancel');
  t.after(async () => {
    releaseOpen();
    await Promise.all(streams.filter((stream) => !stream.closed).map(async (stream) => {
      const closed = once(stream, 'close');
      stream.destroy();
      await closed;
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dest, streams, opening, releaseOpen, CancelSource,
    respond: () => respond(),
    fail: (error) => request.emit('error', error),
    download: (options) => downloadFile('https://example.invalid/archive', dest, () => {}, options),
    requested: () => request !== undefined,
  };
}

test('successful downloads preserve their complete contents', async (t) => {
  const f = fixture(t);
  const pending = f.download();
  f.respond().end('data');
  await f.opening;
  f.releaseOpen();
  await pending;
  assert.equal(fs.readFileSync(f.dest, 'utf8'), 'data');
});

for (const cause of ['cancellation', 'network error']) {
  test(`${cause} waits for a pending file open before removing the partial archive`, async (t) => {
    const f = fixture(t);
    const cancel = new f.CancelSource();
    let settled = false;
    const pending = f.download({
      cancel,
      onProgress: () => {
        if (cause === 'cancellation') cancel.cancel();
      },
    }).then(() => ({ succeeded: true }), (error) => error).finally(() => { settled = true; });
    f.respond().write('data');
    await f.opening;
    if (cause === 'network error') f.fail(new Error('Connection reset'));
    await new Promise(setImmediate);
    assert.equal(settled, false, 'must not finish cleanup while the file can still be created');
    f.releaseOpen();
    const failure = await pending;
    assert.equal(failure.name, cause === 'cancellation' ? 'CancelledError' : 'Error');
    assert.ok(f.streams.every((stream) => stream.closed));
    assert.equal(fs.existsSync(f.dest), false);
  });
}

test('a response queued before cancellation cannot create a file afterwards', async (t) => {
  const f = fixture(t);
  const cancel = new f.CancelSource();
  const pending = f.download({ cancel }).catch((error) => error);
  cancel.cancel();
  assert.equal((await pending).name, 'CancelledError');
  f.respond().end('data');
  await new Promise(setImmediate);
  assert.equal(f.streams.length, 0);
  assert.equal(fs.existsSync(f.dest), false);
});

test('cancellation from the final progress report removes an already closed file', async (t) => {
  const f = fixture(t);
  const cancel = new f.CancelSource();
  let reports = 0;
  const pending = f.download({ cancel, onProgress: () => {
    if (++reports === 2) cancel.cancel();
  } }).catch((error) => error);
  f.respond().end('data');
  await f.opening;
  f.releaseOpen();
  assert.equal((await pending).name, 'CancelledError');
  assert.equal(reports, 2);
  assert.equal(fs.existsSync(f.dest), false);
});

test('an already cancelled download starts no request or file stream', async (t) => {
  const f = fixture(t);
  const cancel = new f.CancelSource();
  cancel.cancel();
  const failure = await f.download({ cancel }).catch((error) => error);
  assert.equal(failure.name, 'CancelledError');
  assert.equal(f.requested(), false);
  assert.equal(f.streams.length, 0);
});
