import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'vitest';

import { JevHttpClient, JEV_ENDPOINT } from '../../../mcp-server/src/semantic/providers/jev/http-client.ts';
import { JEV_MAX_REQUEST_BYTES } from '../../../mcp-server/src/semantic/providers/jev/request-limits.ts';

const token = 'test-secret-token';
const task = 'private full task body';
const control = (signal = new globalThis.AbortController().signal, onOutput = () => {}) => ({
  endpoint: JEV_ENDPOINT, redirect: 'error', signal, onOutput,
});
const client = (fetcher, options = {}) => new JevHttpClient({
  credential: () => token, timeoutMs: 50, maxResponseBytes: 100, fetcher, ...options,
});

test('J05 sends one exact POST with bearer credential and returns a bounded JSON response', async () => {
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(url, JEV_ENDPOINT);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    assert.equal(init.body, task);
    return new globalThis.Response('{"model":"jev-1.13.0"}', { status: 200 });
  };
  const chunks = [];
  assert.deepEqual(await client(fetcher).post(task, control(undefined, chunk => chunks.push(chunk))), {
    status: 'response', body: { model: 'jev-1.13.0' }, providerAccepted: 'confirmed',
  });
  assert.equal(calls, 1);
  assert.equal(Buffer.concat(chunks).toString('utf8'), '{"model":"jev-1.13.0"}');
});

test('J05 distinguishes 429, timeout and ambiguous failures without retry or secret disclosure', async () => {
  let calls = 0;
  const limited = client(async () => { calls++; return new globalThis.Response(null, { status: 429 }); });
  assert.deepEqual(await limited.post(task, control()), { status: 'rate-limited', providerAccepted: 'no' });
  assert.equal(calls, 1);
  const timed = client((_url, init) => { calls++; return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error(`${token} ${task}`)), { once: true });
  }); }, { timeoutMs: 5 });
  const timeout = await timed.post(task, control());
  assert.deepEqual(timeout, { status: 'timeout', providerAccepted: 'unknown' });
  assert.equal(calls, 2);
  const ambiguous = client(async () => { calls++; throw new Error(`${token} ${task}`); });
  const failed = await ambiguous.post(task, control());
  assert.deepEqual(failed, { status: 'uncertain', providerAccepted: 'unknown' });
  assert.equal(calls, 3);
  assert.equal(JSON.stringify([timeout, failed]).includes(token), false);
  assert.equal(JSON.stringify([timeout, failed]).includes(task), false);
});

test('J05 rejects redirects and oversized responses without following or admitting output', async () => {
  let calls = 0;
  const redirected = client(async () => { calls++; return new globalThis.Response(null, { status: 302 }); });
  assert.deepEqual(await redirected.post(task, control()),
    { status: 'redirect-rejected', providerAccepted: 'unknown' });
  assert.equal(calls, 1);
  await assert.rejects(redirected.post(task, { ...control(), endpoint: 'https://other.example/v1/systemone' }),
    /approved exact endpoint/);
  assert.equal(calls, 1);
  const capped = client(async () => { calls++; return new globalThis.Response('abcdef', { status: 200 }); },
    { maxResponseBytes: 5 });
  assert.deepEqual(await capped.post(task, control()), { status: 'uncertain', providerAccepted: 'unknown' });
  assert.equal(calls, 2);
});

test('J05 prevents oversized request dispatch and rejects malformed success bodies', async () => {
  let calls = 0;
  const transport = client(async () => { calls++; return new globalThis.Response('not-json', { status: 200 }); });
  assert.deepEqual(await transport.post('a'.repeat(JEV_MAX_REQUEST_BYTES + 1), control()),
    { status: 'unsupported-bytes', providerAccepted: 'no' });
  assert.equal(calls, 0);
  assert.deepEqual(await transport.post(task, control()), { status: 'uncertain', providerAccepted: 'unknown' });
  assert.equal(calls, 1);
});

test('J05 honors runner output cancellation and keeps credential errors private', async () => {
  let calls = 0;
  const transport = client(async () => { calls++; return new globalThis.Response('response', { status: 200 }); });
  const aborter = new globalThis.AbortController();
  assert.deepEqual(await transport.post(task, control(aborter.signal, () => aborter.abort())),
    { status: 'uncertain', providerAccepted: 'unknown' });
  assert.equal(calls, 1);
  const badCredential = client(async () => { calls++; return new globalThis.Response('{}'); },
    { credential: () => { throw new Error(token); } });
  await assert.rejects(badCredential.post(task, control()), error => {
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('J05 rejects success after a synchronously blocked fetch exceeds its monotonic deadline', async () => {
  const transport = client(() => {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* Mock a blocking transport callback. */ }
    return Promise.resolve(new globalThis.Response('{}', { status: 200 }));
  }, { timeoutMs: 5 });
  assert.deepEqual(await transport.post(task, control()),
    { status: 'timeout', providerAccepted: 'unknown' });
});

test('J05 keeps timeout classification when a delayed JSON parse fails', async () => {
  const originalParse = globalThis.JSON.parse;
  let enteredParse = false;
  globalThis.JSON.parse = () => {
    enteredParse = true;
    const until = performance.now() + 550;
    while (performance.now() < until) { /* Mock a blocking decoder before failure. */ }
    throw new SyntaxError('malformed response');
  };
  try {
    const transport = client(async () => new globalThis.Response('not-json', { status: 200 }),
      { timeoutMs: 500 });
    assert.deepEqual(await transport.post(task, control()),
      { status: 'timeout', providerAccepted: 'unknown' });
    assert.equal(enteredParse, true);
  } finally {
    globalThis.JSON.parse = originalParse;
  }
});

test('J05 cancels open 302, 429 and 500 response bodies before returning', async () => {
  let calls = 0;
  for (const [code, expected] of [
    [302, { status: 'redirect-rejected', providerAccepted: 'unknown' }],
    [429, { status: 'rate-limited', providerAccepted: 'no' }],
    [500, { status: 'uncertain', providerAccepted: 'unknown' }],
  ]) {
    let cancelled = false;
    const stream = new globalThis.ReadableStream({ cancel() { cancelled = true; } });
    const transport = client(async () => { calls++; return new globalThis.Response(stream, { status: code }); });
    assert.deepEqual(await transport.post(task, control()), expected);
    assert.equal(cancelled, true);
  }
  assert.equal(calls, 3);
});

test('J05 waits for response body cancellation before releasing an error result', async () => {
  let started, finish;
  const cancelStarted = new Promise(resolve => { started = resolve; });
  const stream = new globalThis.ReadableStream({ cancel() {
    started();
    return new Promise(resolve => { finish = resolve; });
  } });
  const transport = client(async () => new globalThis.Response(stream, { status: 429 }));
  const pending = transport.post(task, control());
  let settled = false;
  void pending.then(() => { settled = true; });
  await cancelStarted;
  assert.equal(settled, false);
  finish();
  assert.deepEqual(await pending, { status: 'rate-limited', providerAccepted: 'no' });
});
