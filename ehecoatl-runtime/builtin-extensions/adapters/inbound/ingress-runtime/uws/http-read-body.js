// adapters/inbound/ingress-runtime/uws/uws-http-read-body.js


'use strict';


const multipartStream = require(`./multipart/multipart-stream`);
const parseBytes = require(`@/utils/parse-bytes`);

const CONTENT_TYPE_URLENCODED = `application/x-www-form-urlencoded`;
const CONTENT_TYPE_MULTIPART = `multipart/form-data`;
const CONTENT_TYPE_JSON = `application/json`;
const CONTENT_TYPE = `content-type`;
const preloadedBodies = new WeakMap();

//TODO: timeout reject

/** @param {import('@/_core/runtimes/ingress-runtime/execution/execution-context')} executionContext  */
function readBody(executionContext) {
  return new Promise(async (resolve, reject) => {
    const {
      ingressRuntime,
      requestData,
      projectRoute,
      res
    } = executionContext;
    const middlewareStackRuntimeConfig = ingressRuntime.middlewareStackRuntimeConfig ?? {};
    const { maxInputBytes } = middlewareStackRuntimeConfig;
    const config = middlewareStackRuntimeConfig;

    const MAX_INPUT_BYTES = parseBytes(projectRoute.maxInputBytes ?? maxInputBytes);

    const contentLength = Number(requestData.headers["content-length"]);
    if (contentLength && contentLength > MAX_INPUT_BYTES)
      return reject("413 Payload Too Large");

    const contentType = requestData.headers[CONTENT_TYPE] || ``;
    const preloadedBodyPromise = consumePreloadedBody(executionContext);
    if (preloadedBodyPromise) {
      try {
        const buffer = await preloadedBodyPromise;
        if (buffer.byteLength > MAX_INPUT_BYTES)
          return reject("413 Payload Too Large");

        if (contentType.includes(CONTENT_TYPE_MULTIPART)) {
          const UPLOAD_PATH = projectRoute.upload?.uploadPath ?? config.uploadPath;
          const parser = multipartStream(contentType, requestData, UPLOAD_PATH);
          parser.write(buffer);
          parser.end?.();
          return resolve();
        }

        requestData.body = parseBufferedBody(buffer, contentType);
        return resolve();
      } catch (error) {
        return reject(error);
      }
    }

    //MULTIPART UPLOAD
    if (contentType.includes(CONTENT_TYPE_MULTIPART)) {
      const UPLOAD_PATH = projectRoute.upload?.uploadPath ?? config.uploadPath;
      const parser = multipartStream(contentType, requestData, UPLOAD_PATH);
      let received = 0;
      res.onData((chunk, isLast) => {
        try {
          received += chunk.byteLength;
          if (received > MAX_INPUT_BYTES)
            return reject("413 Payload Too Large");

          parser.write(Buffer.from(chunk));

          if (isLast) resolve();
        } catch (error) {
          reject(error);
        }
      });
    }
    //OTHER BODIES
    else {
      const bodyBuffer = [];
      let received = 0;
      res.onData((chunk, isLast) => {
        try {
          received += chunk.byteLength;
          if (received > MAX_INPUT_BYTES)
            return reject("413 Payload Too Large");

          bodyBuffer.push(Buffer.from(chunk));
          if (isLast) {
            const buffer = Buffer.concat(bodyBuffer);
            if (contentType.includes(CONTENT_TYPE_JSON)) {
              requestData.body = JSON.parse(buffer.toString());
            } else if (contentType.includes(CONTENT_TYPE_URLENCODED)) {
              requestData.body = {};
              const params = new URLSearchParams(buffer.toString());
              for (const [key, value] of params) requestData.body[key] = value;
            } else {
              requestData.body = Buffer.concat(bodyBuffer).toString();
            }
            resolve();
          }
        } catch (error) {
          reject(error);
        }
      });
    }
  });
}

readBody.primeBufferedBody = function primeBufferedBody(executionContext) {
  if (!executionContext?.res || typeof executionContext.res.onData !== `function` || preloadedBodies.has(executionContext)) return;

  preloadedBodies.set(executionContext, new Promise((resolve, reject) => {
    const chunks = [];
    executionContext.res.onData((chunk, isLast) => {
      try {
        chunks.push(Buffer.from(chunk));
        if (isLast) {
          resolve(Buffer.concat(chunks));
        }
      } catch (error) {
        reject(error);
      }
    });
  }));
};

function consumePreloadedBody(executionContext) {
  const promise = preloadedBodies.get(executionContext) ?? null;
  if (promise) {
    preloadedBodies.delete(executionContext);
  }
  return promise;
}

function parseBufferedBody(buffer, contentType) {
  if (contentType.includes(CONTENT_TYPE_JSON)) {
    return JSON.parse(buffer.toString());
  }
  if (contentType.includes(CONTENT_TYPE_URLENCODED)) {
    const body = {};
    const params = new URLSearchParams(buffer.toString());
    for (const [key, value] of params) body[key] = value;
    return body;
  }
  return buffer.toString();
}

module.exports = readBody;
