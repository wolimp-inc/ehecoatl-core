// _core/runtimes/ingress-runtime/execution/execution-context.js


'use strict';


const TenantRoute = require(`@/_core/runtimes/ingress-runtime/execution/tenant-route`);
const ResponseData = require(`@/_core/runtimes/ingress-runtime/execution/response-data`);
const RequestData = require(`@/_core/runtimes/ingress-runtime/execution/request-data`);
const ExecutionMetaData = require(`@/_core/runtimes/ingress-runtime/execution/execution-meta-data`);
const IngressRuntime = require(`@/_core/runtimes/ingress-runtime`);
const { classifyRequestLatency } = require(`@/utils/observability/request-latency-classifier`);

/** Per-request runtime state object used across engine, middleware stack, and response execution. */
class ExecutionContext {
  id;

  #idle;
  #aborted;

  plugin;
  hooks;
  ingressRuntime;
  directorHelper;
  services;
  middlewareStackRuntimeConfig;

  /** @type {RequestData} */
  requestData;
  /** @type {ResponseData} */
  responseData;
  /** @type {ExecutionMetaData} */
  meta;

  sessionData;
  finishCallbacks;
  finishCallbacksCalled;
  metaFinalized;

  /** @type {TenantRoute} */
  tenantRoute;

  /**
   * 
   * @param {IngressRuntime} ingressRuntime 
   * @param {*} param0 
   */
  /** Initializes the per-request execution state shared across engine, middleware stack, and response flow. */
  constructor(ingressRuntime, {
    ws, message, isBinary,
    req, res, ip
  }, {
    runRequestStartHook = true
  } = {}) {
    this.#idle = false;
    this.#aborted = false;

    this.ip = ip;
    this.req = req;
    this.res = res;

    this.plugin = ingressRuntime.plugin;

    const { RESPONSE, REQUEST } = this.plugin.hooks.TRANSPORT;
    this.hooks = { RESPONSE, REQUEST };

    this.ingressRuntime = ingressRuntime;
    this.directorHelper = ingressRuntime.createDirectorHelper(this);
    this.services = ingressRuntime.services;
    this.middlewareStackRuntimeConfig = ingressRuntime.middlewareStackRuntimeConfig
      ?? ingressRuntime.middlewareStackRuntime?.config
      ?? null;

    this.responseData = new ResponseData();
    this.sessionData = {};
    this.finishCallbacks = [];
    this.finishCallbacksCalled = false;
    this.metaFinalized = false;

    this.meta = new ExecutionMetaData();

    this.run = this.run.bind(this);
    if (runRequestStartHook) {
      this.run(this.hooks.REQUEST.START, this.hooks.REQUEST.ERROR);
    }

    Object.preventExtensions(this);
  }

  /** Reports whether request execution has been aborted. */
  isAborted() { return this.#aborted; }
  /** Marks the execution context as aborted and emits the request break hook. */
  abort() {
    this.#aborted = true;
    this.run(this.hooks.REQUEST.BREAK, this.hooks.REQUEST.ERROR);
  }
  /** Reports whether the execution context is currently marked idle. */
  isIdle() { return this.#idle; }
  /** Marks the execution context as idle for detached or long-lived flows. */
  idle() { this.#idle = true; }

  /** Runs one hook with the execution context itself as hook payload. */
  run(hookId, errHook = null) {
    return this.plugin.run(hookId, this, errHook);
  }

  /** Normalizes and attaches request data for the current inbound transport payload. */
  async setupRequestData(params) {
    this.requestData = new RequestData(params);
  }

  /** Delegates HTTP middleware stack execution to the owning network runtime. */
  runHttpMiddlewareStack() {
    return this.ingressRuntime.middlewareStackRuntime.runHttpMiddlewareStack(this);
  }

  /** Delegates websocket upgrade middleware stack execution to the owning network runtime. */
  runWsUpgradeMiddlewareStack() {
    return this.ingressRuntime.middlewareStackRuntime.runWsUpgradeMiddlewareStack(this);
  }

  /** Emits the request end hook for the current execution context. */
  async end({ runRequestEndHook = true } = {}) {
    try {
      await this.callFinishCallbacks();
    } finally {
      this.finalizeMeta();
    }
    if (!runRequestEndHook) return Promise.resolve();
    return this.run(this.hooks.REQUEST.END, this.hooks.REQUEST.ERROR);
  }

  /**
   * FINISH CALLS
   */

  /** Registers a callback to be executed when the request lifecycle finishes. */
  addFinishCallback(callback) {
    if (typeof callback === `function`)
      this.finishCallbacks.push(callback);
  }

  /** Executes all registered finish callbacks without freezing request metadata early. */
  async callFinishCallbacks() {
    if (this.finishCallbacksCalled) return;
    this.finishCallbacksCalled = true;
    const callbacks = this.finishCallbacks.splice(0);
    for (const c of callbacks) {
      if (typeof c !== `function`) continue;
      try {
        await c();
      } catch (error) {
        console.error(`[execution-context] finish callback failed`, error?.stack ?? error?.message ?? error);
      }
    }
  }

  /** Finalizes immutable request metadata once the full request lifecycle has completed. */
  finalizeMeta() {
    if (this.metaFinalized) return;

    this.meta.finishedAt = Date.now();
    this.meta.duration = this.meta.finishedAt - this.meta.startedAt;
    const latencyClassification = classifyRequestLatency({
      durationMs: this.meta.duration,
      tenantRoute: this.tenantRoute,
      meta: this.meta,
      config: this.ingressRuntime?.middlewareStackRuntime?.config?.latencyClassification
    });
    if (latencyClassification) {
      this.meta.latencyProfile = latencyClassification.profile;
      this.meta.latencyClass = latencyClassification.class;
      this.meta.latencyThresholds = latencyClassification.thresholds;
    }
    if (this.meta.actionMeta) {
      Object.freeze(this.meta.actionMeta);
    }
    Object.freeze(this.meta);
    this.metaFinalized = true;
  }
}

module.exports = ExecutionContext;
Object.freeze(module.exports);
