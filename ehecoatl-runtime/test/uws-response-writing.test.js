// test/uws-response-writing.test.js


'use strict';

require(`module-alias/register`);

const test = require(`node:test`);
const assert = require(`node:assert/strict`);
const { PassThrough } = require(`node:stream`);

const writeHttpResponse = require(`@adapter/inbound/ingress-runtime/uws/http-write-response`);
const createTokenBucketLimiter = require(`@/utils/limiter/request-limiter-http`);
const { toStatusLine } = require(`@/utils/http/http-response-write`);

function createMockUwsResponse() {
  const events = [];
  let insideCork = false;

  return {
    events,
    cork(callback) {
      events.push({ type: `cork:start` });
      insideCork = true;
      callback();
      insideCork = false;
      events.push({ type: `cork:end` });
      return this;
    },
    writeStatus(status) {
      events.push({ type: `writeStatus`, status, insideCork });
      return this;
    },
    writeHeader(key, value) {
      events.push({ type: `writeHeader`, key, value, insideCork });
      return this;
    },
    write(chunk) {
      events.push({ type: `write`, chunk: Buffer.from(chunk).toString(), insideCork });
      return true;
    },
    end(body) {
      events.push({
        type: `end`,
        body: body == null ? null : Buffer.from(body).toString(),
        insideCork
      });
      return this;
    },
    onWritable(handler) {
      this.onWritableHandler = handler;
      events.push({ type: `onWritable` });
      return this;
    },
    onAborted(handler) {
      this.onAbortedHandler = handler;
      events.push({ type: `onAborted` });
      return this;
    }
  };
}

function createExecutionContext(responseData, res) {
  return {
    responseData,
    requestData: {
      method: `GET`
    },
    projectRoute: null,
    manager: {
      setCookiesSession: async () => { }
    },
    services: {
      storage: {
        async readStream() {
          throw new Error(`storage.readStream should be stubbed in this test`);
        }
      }
    },
    res,
    hooks: {
      RESPONSE: {
        WRITE: {
          START: `response.write.start`,
          ERROR: `response.write.error`,
          BREAK: `response.write.break`,
          END: `response.write.end`
        }
      }
    },
    async run() { },
    isAborted() {
      return false;
    }
  };
}

test(`toStatusLine expands numeric statuses into full status lines`, () => {
  assert.equal(toStatusLine(200), `200 OK`);
  assert.equal(toStatusLine(`404`), `404 Not Found`);
  assert.equal(toStatusLine(`422 Unprocessable Content`), `422 Unprocessable Content`);
});

test(`writeHttpResponse corks status, headers, and string bodies`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createExecutionContext({
    status: 201,
    headers: { 'X-Test': `yes` },
    body: `hello`
  }, res);

  await writeHttpResponse(executionContext);

  assert.deepEqual(
    res.events.filter((event) => event.type === `writeStatus`).map((event) => event.status),
    [`201 Created`]
  );
  assert.ok(
    res.events
      .filter((event) => [`writeStatus`, `writeHeader`, `end`].includes(event.type))
      .every((event) => event.insideCork),
    `expected all response writes to happen inside cork()`
  );
});

test(`writeHttpResponse adds a JSON content type when serializing objects`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createExecutionContext({
    status: 200,
    headers: {},
    body: { ok: true }
  }, res);

  await writeHttpResponse(executionContext);

  assert.deepEqual(
    res.events.filter((event) => event.type === `writeHeader`).map((event) => [event.key, event.value]),
    [[`Content-Type`, `application/json`]]
  );
  assert.deepEqual(
    res.events.filter((event) => event.type === `end`).map((event) => event.body),
    [`{"ok":true}`]
  );
});

test(`writeHttpResponse applies the route cache-control default when the response does not override it`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createExecutionContext({
    status: 200,
    headers: {},
    body: `cached`
  }, res);
  executionContext.projectRoute = {
    cache: 60
  };

  await writeHttpResponse(executionContext);

  assert.deepEqual(
    res.events.filter((event) => event.type === `writeHeader`).map((event) => [event.key, event.value]),
    [[`Cache-Control`, `public, max-age=60`]]
  );
});

test(`writeHttpResponse preserves explicit cache-control headers over the route default`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createExecutionContext({
    status: 200,
    headers: {
      'cache-control': `private, max-age=5`
    },
    body: `cached`
  }, res);
  executionContext.projectRoute = {
    cache: `public, max-age=60, stale-while-revalidate=30`
  };

  await writeHttpResponse(executionContext);

  assert.deepEqual(
    res.events.filter((event) => event.type === `writeHeader`).map((event) => [event.key, event.value]),
    [[`cache-control`, `private, max-age=5`]]
  );
});

test(`writeHttpResponse suppresses HEAD string and object bodies while preserving headers`, async () => {
  const stringRes = createMockUwsResponse();
  const stringExecutionContext = createExecutionContext({
    status: 200,
    headers: { 'X-Test': `yes` },
    body: `hello`
  }, stringRes);
  stringExecutionContext.requestData.method = `HEAD`;

  await writeHttpResponse(stringExecutionContext);

  assert.deepEqual(
    stringRes.events.filter((event) => event.type === `end`).map((event) => event.body),
    [null]
  );

  const objectRes = createMockUwsResponse();
  const objectExecutionContext = createExecutionContext({
    status: 200,
    headers: {},
    body: { ok: true }
  }, objectRes);
  objectExecutionContext.requestData.method = `HEAD`;

  await writeHttpResponse(objectExecutionContext);

  assert.deepEqual(
    objectRes.events.filter((event) => event.type === `writeHeader`).map((event) => [event.key, event.value]),
    [[`Content-Type`, `application/json`]]
  );
  assert.deepEqual(
    objectRes.events.filter((event) => event.type === `end`).map((event) => event.body),
    [null]
  );
});

test(`writeHttpResponse corks streamed response head and chunks`, async () => {
  const res = createMockUwsResponse();
  const body = new PassThrough();
  const executionContext = createExecutionContext({
    status: 200,
    headers: { 'Content-Type': `text/plain; charset=utf-8` },
    body
  }, res);

  const pendingWrite = writeHttpResponse(executionContext);
  body.write(`hello`);
  body.end(` world`);
  await pendingWrite;

  assert.ok(res.events.some((event) => event.type === `onWritable`));
  assert.deepEqual(
    res.events.filter((event) => event.type === `write`).map((event) => event.chunk),
    [`hello`, ` world`]
  );
  assert.ok(
    res.events
      .filter((event) => [`writeStatus`, `writeHeader`, `write`, `end`].includes(event.type))
      .every((event) => event.insideCork),
    `expected streamed writes to happen inside cork()`
  );
});

test(`writeHttpResponse resolves only after streamed bodies finish`, async () => {
  const res = createMockUwsResponse();
  const body = new PassThrough();
  const executionContext = createExecutionContext({
    status: 200,
    headers: { 'Content-Type': `text/plain; charset=utf-8` },
    body
  }, res);

  let settled = false;
  const pendingWrite = writeHttpResponse(executionContext).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  body.end(`stream complete`);
  await pendingWrite;

  assert.equal(settled, true);
  assert.ok(res.events.some((event) => event.type === `write`));
  assert.ok(res.events.some((event) => event.type === `end`));
});

test(`writeHttpResponse suppresses HEAD stream and storage-stream bodies without writing chunks`, async () => {
  const streamedRes = createMockUwsResponse();
  const body = new PassThrough();
  const streamedExecutionContext = createExecutionContext({
    status: 200,
    headers: { 'Content-Type': `text/plain; charset=utf-8` },
    body
  }, streamedRes);
  streamedExecutionContext.requestData.method = `HEAD`;

  await writeHttpResponse(streamedExecutionContext);

  assert.equal(streamedRes.events.some((event) => event.type === `write`), false);
  assert.deepEqual(
    streamedRes.events.filter((event) => event.type === `end`).map((event) => event.body),
    [null]
  );
  assert.equal(body.destroyed, true);

  const storageStreamRes = createMockUwsResponse();
  let readStreamCalls = 0;
  const storageExecutionContext = createExecutionContext({
    status: 200,
    headers: { 'Content-Type': `text/plain; charset=utf-8` },
    body: {
      __ehecoatlBodyKind: `storage-stream`,
      path: `/tmp/demo`
    }
  }, storageStreamRes);
  storageExecutionContext.requestData.method = `HEAD`;
  storageExecutionContext.services.storage.readStream = async () => {
    readStreamCalls += 1;
    return new PassThrough();
  };

  await writeHttpResponse(storageExecutionContext);

  assert.equal(readStreamCalls, 0);
  assert.deepEqual(
    storageStreamRes.events.filter((event) => event.type === `end`).map((event) => event.body),
    [null]
  );
});

test(`writeHttpResponse preserves nginx internal redirect headers for HEAD responses`, async () => {
  const res = createMockUwsResponse();
  const executionContext = createExecutionContext({
    status: 200,
    headers: {},
    body: {
      __ehecoatlBodyKind: `nginx-internal-redirect`,
      uri: `/internal/static/demo.txt`
    }
  }, res);
  executionContext.requestData.method = `HEAD`;

  await writeHttpResponse(executionContext);

  assert.deepEqual(
    res.events.filter((event) => event.type === `writeHeader`).map((event) => [event.key, event.value]),
    [[`X-Accel-Redirect`, `/internal/static/demo.txt`]]
  );
  assert.deepEqual(
    res.events.filter((event) => event.type === `end`).map((event) => event.body),
    [null]
  );
});

test(`request limiter corks blocked uWS responses`, async () => {
  const limiter = createTokenBucketLimiter({
    capacity: 0,
    refillRateSeconds: 0
  });
  const res = createMockUwsResponse();
  let nextCalled = false;

  await limiter(`127.0.0.1`, res, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.deepEqual(
    res.events.filter((event) => event.type === `writeStatus`).map((event) => event.status),
    [`429 Too Many Requests`]
  );
  assert.ok(
    res.events
      .filter((event) => [`writeStatus`, `writeHeader`, `end`].includes(event.type))
      .every((event) => event.insideCork),
    `expected limiter response writes to happen inside cork()`
  );
});
