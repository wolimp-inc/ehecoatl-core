// _core/runtimes/middleware-stack-runtime/middleware-stack-runtime.js


'use strict';


const MiddlewareContext = require(`./middleware-context`);
const WsMessageContext = require(`./ws-message-context`);
const { buildIsolatedRuntimeLabel } = require(`@/utils/process-labels`);
const { parseWsActionMessage } = require(`@/utils/ws/parse-ws-action-message`);

/** Transport orchestrator use case that executes ordered HTTP middleware stacks with hook-aware flow control. */
class MiddlewareStackRuntime {
  maxInputBytes;
  /** @type {import('@/_core/orchestrators/plugin-orchestrator')} */
  plugin;
  middlewareStackResolver;
  coreMiddlewares;
  coreMiddlewareOrder;

  /** Captures middleware stack config, executor access, and middleware registries for request execution. */
  constructor(kernelContext) {
    this.config = kernelContext.config.adapters.middlewareStackRuntime;
    this.maxInputBytes = this.config.maxInputBytes;
    this.plugin = kernelContext.pluginOrchestrator;
    this.middlewareStackResolver = kernelContext.useCases.middlewareStackResolver;
    this.coreMiddlewares = Object.freeze({
      http: Object.freeze({
        ...(this.middlewareStackResolver?.getCoreMiddlewares?.(`http`) ?? {})
      }),
      ws: Object.freeze({
        ...(this.middlewareStackResolver?.getCoreMiddlewares?.(`ws`) ?? {})
      })
    });
    this.coreMiddlewareOrder = Object.freeze({
      http: Object.freeze([
        ...(this.middlewareStackResolver?.getCoreMiddlewareOrder?.(`http`) ?? [])
      ]),
      ws: Object.freeze([
        ...(this.middlewareStackResolver?.getCoreMiddlewareOrder?.(`ws`) ?? [])
      ])
    });

    Object.freeze(this);
  }

  /**
   * Executes the configured HTTP middleware stacks with middleware lifecycle hooks.
   * @param {import('@/_core/runtimes/ingress-runtime/execution/execution-context')} executionContext
   */
  async runHttpMiddlewareStack(executionContext) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const stackHooks = hooks.TRANSPORT.MIDDLEWARE_STACK;
    try {
      if (executionContext.isAborted() || executionContext.projectRoute.isRedirect()) {
        await plugin.run(stackHooks.BREAK, executionContext, stackHooks.ERROR);
        return;
      }

      const middlewareContext = new MiddlewareContext(executionContext);
      const descriptors = await this.#buildUnifiedHttpStack(middlewareContext);
      await this.#runStack({
        descriptors,
        executionContext,
        stackContext: middlewareContext
      });
    } catch (error) {
      console.error(`[middleware-stack-runtime] http stack failed`, {
        url: executionContext?.requestData?.url ?? null,
        route: executionContext?.projectRoute?.pointsTo ?? null,
        error: error?.stack ?? error?.message ?? error
      });
      await plugin.run(stackHooks.ERROR, executionContext);
      executionContext.responseData.status = 500;
      executionContext.responseData.body = `Internal Server Middleware Stack Error`;
    } finally {
      executionContext.meta.currentMiddlewareIndex = null;
      executionContext.meta.currentMiddlewareName = null;
      await executionContext.callFinishCallbacks();
    }
  }

  /**
   * Executes route-bound HTTP middlewares followed by optional app ws-upgrade middleware.
   * @param {import('@/_core/runtimes/ingress-runtime/execution/execution-context')} executionContext
   */
  async runWsUpgradeMiddlewareStack(executionContext) {
    const plugin = this.plugin;
    const { hooks } = plugin;
    const stackHooks = hooks.TRANSPORT.MIDDLEWARE_STACK;
    try {
      if (executionContext.isAborted() || !executionContext.projectRoute) {
        await plugin.run(stackHooks.BREAK, executionContext, stackHooks.ERROR);
        return;
      }

      const middlewareContext = new MiddlewareContext(executionContext);
      const descriptors = await this.#buildWsUpgradeStack(middlewareContext);
      await this.#runStack({
        descriptors,
        executionContext,
        stackContext: middlewareContext
      });
    } catch (error) {
      console.error(`[middleware-stack-runtime] ws-upgrade stack failed`, {
        url: executionContext?.requestData?.url ?? null,
        route: executionContext?.projectRoute?.pointsTo ?? null,
        error: error?.stack ?? error?.message ?? error
      });
      await plugin.run(stackHooks.ERROR, executionContext);
      executionContext.responseData.status = 500;
      executionContext.responseData.body = `Internal Server Middleware Stack Error`;
    } finally {
      executionContext.meta.currentMiddlewareIndex = null;
      executionContext.meta.currentMiddlewareName = null;
      await executionContext.callFinishCallbacks();
    }
  }

  /**
   * Executes inbound websocket message validation, optional ws-message middleware, and action dispatch.
   * @param {import('./ws-message-context')} wsMessageContext
   */
  async runWsMessageMiddlewareStack(wsMessageContext) {
    const stackContext = wsMessageContext instanceof WsMessageContext
      ? wsMessageContext
      : new WsMessageContext(wsMessageContext ?? {});
    const descriptors = await this.#buildWsMessageStack(stackContext);
    await this.#dispatchWsMessageStack({
      descriptors,
      stackContext,
      index: 0
    });
    return {
      discarded: stackContext.isDiscarded(),
      discardReason: stackContext.getDiscardReason?.() ?? null,
      replySent: stackContext.hasReplySent?.() ?? false,
      wsMessageData: stackContext.wsMessageData
    };
  }

  /**
   * Runs one async middleware stack and reports whether the full chain reached the end.
   * @param {{
   * descriptors: Array<{ name: string, execute: (stackContext: any, next: ()=>Promise<void>) => Promise<any> }>,
   * executionContext: import('@/_core/runtimes/ingress-runtime/execution/execution-context'),
   * stackContext: any
   * }} params
   */
  async #runStack({
    descriptors,
    executionContext,
    stackContext
  }) {
    const plugin = this.plugin;
    const stackHooks = plugin.hooks.TRANSPORT.MIDDLEWARE_STACK;
    const middlewareHooks = stackHooks.MIDDLEWARE;

    await plugin.run(stackHooks.START, executionContext, stackHooks.ERROR);
    const completedAll = await this.#dispatchHttpStack({
      descriptors,
      executionContext,
      stackContext,
      middlewareHooks,
      index: 0
    });

    if (!completedAll || executionContext.isAborted()) {
      await plugin.run(stackHooks.BREAK, executionContext, stackHooks.ERROR);
      return { completedAll: false };
    }

    await plugin.run(stackHooks.END, executionContext, stackHooks.ERROR);
    return { completedAll: true };
  }

  async #dispatchHttpStack({
    descriptors,
    executionContext,
    stackContext,
    middlewareHooks,
    index
  }) {
    if (index >= descriptors.length) {
      return true;
    }

    const descriptor = descriptors[index];
    executionContext.meta.currentMiddlewareIndex = index;
    executionContext.meta.currentMiddlewareName = descriptor?.name ?? `middleware_${index}`;
    await this.plugin.run(middlewareHooks.START, executionContext, middlewareHooks.ERROR);

    let nextCalled = false;
    let childCompleted = false;
    await descriptor.execute(stackContext, async () => {
      if (nextCalled) {
        throw new Error(`next() called multiple times by middleware "${descriptor.name}"`);
      }
      nextCalled = true;
      childCompleted = await this.#dispatchHttpStack({
        descriptors,
        executionContext,
        stackContext,
        middlewareHooks,
        index: index + 1
      });
    });

    await this.plugin.run(middlewareHooks.END, executionContext, middlewareHooks.ERROR);

    if (nextCalled) {
      return childCompleted;
    }

    return index === (descriptors.length - 1);
  }

  async #buildUnifiedHttpStack(middlewareContext) {
    const routeDescriptors = await this.#buildRouteHttpStack(middlewareContext);
    const coreDescriptors = await this.#buildCoreHttpStack(middlewareContext);
    return [...routeDescriptors, ...coreDescriptors];
  }

  async #buildWsUpgradeStack(middlewareContext) {
    const routeDescriptors = await this.#buildRouteHttpStack(middlewareContext);
    const wsUpgradeDescriptor = await this.#buildWsUpgradeDescriptor(middlewareContext);
    return wsUpgradeDescriptor
      ? [...routeDescriptors, wsUpgradeDescriptor]
      : routeDescriptors;
  }

  async #buildCoreHttpStack(middlewareContext) {
    const registry = this.coreMiddlewares.http;
    const middlewareOrder = this.coreMiddlewareOrder.http;
    return middlewareOrder
      .map((middlewareName) => {
        const middleware = registry[middlewareName];
        if (typeof middleware !== `function`) {
          throw new Error(`Core middleware "${middlewareName}" is not executable`);
        }
        return Object.freeze({
          name: middlewareName,
          execute: async (stackContext, next) => middleware(stackContext ?? middlewareContext, next)
        });
      });
  }

  async #buildRouteHttpStack(middlewareContext) {
    const middlewareLabels = Array.isArray(middlewareContext.projectRoute?.middleware)
      ? middlewareContext.projectRoute.middleware
      : [];
    if (middlewareLabels.length === 0) {
      return [];
    }

    const tenantHttpMiddlewares = (await resolveTenantMiddlewares(this.middlewareStackResolver)).http;
    const appId = middlewareContext.projectRoute?.origin?.appId ?? null;
    const appMiddlewarePaths = resolveAppMiddlewarePathsFromRoute(middlewareContext.projectRoute);
    const appHttpMiddlewares = appId
      ? (await this.middlewareStackResolver.loadAppMiddlewares(appId, {
          pathsByProtocol: appMiddlewarePaths
        })).http
      : {};

    const visitedLabels = new Set();
    return middlewareLabels.flatMap((middlewareLabel) => expandRouteMiddlewareLabel({
      middlewareLabel,
      middlewareContext,
      builtinHttpMiddlewares: this.coreMiddlewares.http,
      appHttpMiddlewares,
      tenantHttpMiddlewares,
      visitedLabels
    }));
  }

  async #buildWsUpgradeDescriptor(middlewareContext) {
    const appId = middlewareContext.projectRoute?.origin?.appId ?? null;
    if (!appId) return null;

    const appWsMiddlewares = (await this.middlewareStackResolver.loadAppMiddlewares(appId, {
      pathsByProtocol: resolveAppMiddlewarePathsFromRoute(middlewareContext.projectRoute)
    })).ws ?? {};
    const middleware = appWsMiddlewares[`ws-upgrade`] ?? null;
    if (typeof middleware !== `function`) return null;

    return Object.freeze({
      name: `ws-upgrade`,
      execute: async (stackContext, next) => middleware(stackContext ?? middlewareContext, next)
    });
  }

  async #buildWsMessageStack(wsMessageContext) {
    const descriptors = [{
      name: `core-ws-message-validate`,
      execute: async (stackContext, next) => {
        validateWsMessageContext(stackContext);
        if (stackContext.isDiscarded()) return;
        await next();
      }
    }];

    const wsMessageDescriptor = await this.#buildWsMessageDescriptor(wsMessageContext);
    if (wsMessageDescriptor) {
      descriptors.push(wsMessageDescriptor);
    }

    descriptors.push({
      name: `core-ws-message-dispatch`,
      execute: async (stackContext) => {
        if (stackContext.isDiscarded()) return;
        await dispatchWsActionMessage({
          stackContext,
          rpcEndpoint: stackContext.services?.rpc ?? null,
          question: this.config?.question?.tenantWsAction ?? `tenantWsAction`
        });
      }
    });

    return descriptors.map((descriptor) => Object.freeze(descriptor));
  }

  async #buildWsMessageDescriptor(wsMessageContext) {
    const tenantWsMiddlewares = (await resolveTenantMiddlewares(this.middlewareStackResolver)).ws ?? {};
    const appId = wsMessageContext.projectRoute?.origin?.appId ?? null;
    const appMiddlewarePaths = resolveAppMiddlewarePathsFromRoute(wsMessageContext.projectRoute);
    const appWsMiddlewares = appId
      ? (await this.middlewareStackResolver.loadAppMiddlewares(appId, {
          pathsByProtocol: appMiddlewarePaths
        })).ws
      : {};

    const middleware = appWsMiddlewares?.[`ws-message`] ?? tenantWsMiddlewares?.[`ws-message`] ?? null;
    if (typeof middleware !== `function`) return null;

    return Object.freeze({
      name: `ws-message`,
      execute: async (stackContext, next) => middleware(stackContext ?? wsMessageContext, next)
    });
  }

  async #dispatchWsMessageStack({
    descriptors,
    stackContext,
    index
  }) {
    if (index >= descriptors.length || stackContext.isDiscarded()) {
      return true;
    }

    const descriptor = descriptors[index];
    stackContext.meta.currentMiddlewareIndex = index;
    stackContext.meta.currentMiddlewareName = descriptor?.name ?? `ws_message_${index}`;

    let nextCalled = false;
    await descriptor.execute(stackContext, async () => {
      if (nextCalled) {
        throw new Error(`next() called multiple times by middleware "${descriptor.name}"`);
      }
      nextCalled = true;
      await this.#dispatchWsMessageStack({
        descriptors,
        stackContext,
        index: index + 1
      });
    });

    return true;
  }
}

function resolveAppMiddlewarePathsFromRoute(projectRoute) {
  const folders = projectRoute?.folders ?? {};
  const httpPath = typeof folders.httpMiddlewaresRootFolder === `string` && folders.httpMiddlewaresRootFolder.trim()
    ? folders.httpMiddlewaresRootFolder.trim()
    : null;
  const wsPath = typeof folders.wsMiddlewaresRootFolder === `string` && folders.wsMiddlewaresRootFolder.trim()
    ? folders.wsMiddlewaresRootFolder.trim()
    : null;

  if (!httpPath && !wsPath) {
    return null;
  }

  return Object.freeze({
    http: httpPath,
    ws: wsPath
  });
}

module.exports = MiddlewareStackRuntime;
Object.freeze(module.exports);

function expandRouteMiddlewareLabel({
  middlewareLabel,
  middlewareContext,
  builtinHttpMiddlewares,
  appHttpMiddlewares,
  tenantHttpMiddlewares,
  visitedLabels
}) {
  const normalizedLabel = String(middlewareLabel ?? ``).trim();
  if (!normalizedLabel) return [];
  if (visitedLabels.has(normalizedLabel)) {
    throw new Error(`Route middleware group cycle detected at "${normalizedLabel}"`);
  }

  const middleware = appHttpMiddlewares[normalizedLabel]
    ?? tenantHttpMiddlewares[normalizedLabel]
    ?? builtinHttpMiddlewares[normalizedLabel]
    ?? null;
  if (Array.isArray(middleware)) {
    visitedLabels.add(normalizedLabel);
    const expanded = middleware.flatMap((childLabel) => expandRouteMiddlewareLabel({
      middlewareLabel: childLabel,
      middlewareContext,
      builtinHttpMiddlewares,
      appHttpMiddlewares,
      tenantHttpMiddlewares,
      visitedLabels
    }));
    visitedLabels.delete(normalizedLabel);
    return expanded;
  }

  if (typeof middleware !== `function`) {
    throw new Error(`Route middleware "${normalizedLabel}" was not found for app, tenant, or builtin HTTP registries`);
  }

  return [Object.freeze({
    name: normalizedLabel,
    execute: async (stackContext, next) => middleware(stackContext ?? middlewareContext, next)
  })];
}

function validateWsMessageContext(stackContext) {
  const wsMessageData = stackContext.wsMessageData ?? {};
  if (wsMessageData.isBinary === true) {
    stackContext.discard(`binary_payload_not_supported`);
    return;
  }

  const parsed = parseWsActionMessage(wsMessageData.raw, {
    wsActionsAvailable: stackContext.projectRoute?.wsActionsAvailable
      ?? stackContext.projectRoute?.upgrade?.wsActionsAvailable
      ?? null
  });
  if (parsed.success !== true) {
    stackContext.discard(parsed.reason ?? `invalid_message`);
    return;
  }

  stackContext.wsMessageData = Object.freeze({
    ...wsMessageData,
    raw: parsed.raw,
    actionTarget: parsed.actionTarget,
    queryString: parsed.queryString,
    params: parsed.params
  });
}

async function dispatchWsActionMessage({
  stackContext,
  rpcEndpoint,
  question
}) {
  if (!rpcEndpoint || typeof rpcEndpoint.askDetailed !== `function`) {
    stackContext.discard(`ws_action_rpc_unavailable`);
    return;
  }

  const tenantId = stackContext.projectRoute?.origin?.tenantId ?? null;
  const appId = stackContext.projectRoute?.origin?.appId ?? null;
  if (!tenantId || !appId) {
    stackContext.discard(`ws_action_target_unavailable`);
    return;
  }

  const rpcResponse = await rpcEndpoint.askDetailed({
    target: buildIsolatedRuntimeLabel({
      tenantId,
      appId
    }),
    question,
    data: {
      projectRoute: stackContext.projectRoute,
      sessionData: stackContext.sessionData,
      wsMessageData: stackContext.wsMessageData
    }
  }).catch(() => null);

  const response = rpcResponse?.data ?? null;
  if (response?.sessionData && typeof response.sessionData === `object`) {
    replaceSessionDataContents(stackContext.sessionData, response.sessionData);
  }

  if (!response || response.success !== true) {
    return;
  }

  if (response.result !== null && response.result !== undefined) {
    await stackContext.sendToSender(response.result, {
      metadata: {
        source: `ws-action-auto-reply`,
        actionTarget: stackContext.wsMessageData?.actionTarget ?? null
      }
    });
  }
}

function replaceSessionDataContents(target, source) {
  if (!target || typeof target !== `object`) return;
  const nextSource = source && typeof source === `object`
    ? source
    : {};

  for (const key of Object.keys(target)) {
    delete target[key];
  }

  Object.assign(target, nextSource);
}

async function resolveTenantMiddlewares(middlewareStackResolver) {
  if (middlewareStackResolver && typeof middlewareStackResolver.loadTenantMiddlewares === `function`) {
    return middlewareStackResolver.loadTenantMiddlewares();
  }

  if (middlewareStackResolver && typeof middlewareStackResolver.getTenantMiddlewares === `function`) {
    return middlewareStackResolver.getTenantMiddlewares();
  }

  return {
    http: {},
    ws: {}
  };
}
