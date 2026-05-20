// adapters/outbound/ws-hub-manager/local-memory/index.js


'use strict';


const WsHubManagerPort = require(`@/_core/_ports/inbound/ws-hub-manager-port`);
const WsRoomChannel = require(`./ws-room-channel`);

WsHubManagerPort.openClientAdapter = async function openClientAdapter({
  manager,
  channelId,
  clientId,
  ws,
  metadata = {}
}) {
  const normalizedMetadata = normalizeMetadata(metadata);
  const invariantMetadata = extractChannelInvariantMetadata(normalizedMetadata);
  const { entry, created } = ensureChannelEntry(manager, channelId, invariantMetadata);
  if (!created && !areChannelMetadataCompatible(entry.invariantMetadata, invariantMetadata)) {
    closeSocket(ws);
    return {
      success: false,
      reason: `channel_metadata_mismatch`,
      channelId: normalizeChannelId(channelId),
      clientId: normalizeClientId(clientId)
    };
  }

  if (created || !entry.invariantMetadata) {
    entry.invariantMetadata = invariantMetadata;
  }
  clearIdleTimer(entry);
  entry.lastActiveAt = Date.now();
  const client = entry.runtime.registerClient({
    clientId,
    ws,
    metadata: normalizedMetadata
  });
  return {
    success: true,
    channelId: entry.channelId,
    clientId: client.clientId,
    client,
    activeClients: entry.runtime.clientCount()
  };
};

WsHubManagerPort.receiveMessageAdapter = async function receiveMessageAdapter({
  manager,
  channelId,
  clientId,
  message = null,
  isBinary = false,
  metadata = {}
}) {
  const entry = getChannelEntry(manager, channelId);
  if (!entry) {
    return createChannelNotFoundResponse(channelId);
  }

  entry.lastActiveAt = Date.now();
  const inboundEvent = entry.runtime.receiveMessage({
    clientId,
    message,
    isBinary,
    metadata
  });
  if (inboundEvent?.success !== true) {
    return inboundEvent;
  }

  const middlewareStackRuntime = manager?.useCases?.middlewareStackRuntime ?? null;
  if (typeof middlewareStackRuntime?.runWsMessageMiddlewareStack !== `function`) {
    return inboundEvent;
  }

  const client = inboundEvent?.event?.client ?? null;
  const routeSnapshot = client?.metadata?.route ?? entry.invariantMetadata?.route ?? null;
  if (!routeSnapshot) {
    return {
      ...inboundEvent,
      discarded: true,
      discardReason: `missing_route_snapshot`
    };
  }

  const stackResult = await middlewareStackRuntime.runWsMessageMiddlewareStack({
    projectRoute: routeSnapshot,
    sessionData: cloneJsonValue(client?.metadata?.sessionData ?? {}),
    middlewareStackRuntimeConfig: middlewareStackRuntime?.config ?? null,
    services: {
      rpc: manager?.useCases?.rpcEndpoint ?? null,
      cache: manager?.useCases?.sharedCacheService ?? null,
      generateSessionId: () => randomSessionId(),
      syncSessionSnapshot: async ({
        sessionId = null,
        sessionData = {}
      } = {}) => {
        entry.runtime.updateClientMetadata({
          clientId,
          metadata: {
            sessionId: typeof sessionId === `string` && sessionId.trim()
              ? sessionId.trim()
              : null,
            sessionData: cloneJsonValue(sessionData ?? {})
          }
        });
        return true;
      }
    },
    sendToSender: async (outboundMessage, {
      metadata: outboundMetadata = {},
      isBinary: outboundBinary = null
    } = {}) => entry.runtime.sendMessage({
      clientId,
      message: outboundMessage,
      metadata: outboundMetadata,
      isBinary: outboundBinary
    }),
    wsMessageData: Object.freeze({
      raw: inboundEvent?.event?.message ?? null,
      isBinary: Boolean(inboundEvent?.event?.isBinary),
      channelId: entry.channelId,
      clientId: client?.clientId ?? normalizeClientId(clientId),
      client: client ?? null,
      metadata: normalizeMetadata(inboundEvent?.event?.metadata ?? {}),
      actionTarget: null,
      queryString: ``,
      params: Object.freeze({})
    })
  });

  return {
    ...inboundEvent,
    discarded: stackResult?.discarded ?? false,
    discardReason: stackResult?.discardReason ?? null,
    replySent: stackResult?.replySent ?? false,
    wsMessageData: stackResult?.wsMessageData ?? null
  };
};

WsHubManagerPort.closeClientAdapter = async function closeClientAdapter({
  manager,
  channelId,
  clientId,
  code = null,
  reason = null,
  metadata = {}
}) {
  const entry = getChannelEntry(manager, channelId);
  if (!entry) {
    return createChannelNotFoundResponse(channelId);
  }

  entry.lastActiveAt = Date.now();
  const disconnected = entry.runtime.unregisterClient({
    clientId,
    code,
    reason,
    metadata
  });
  if (entry.runtime.clientCount() === 0) {
    scheduleIdleDestroy(manager, entry);
  }

  return {
    success: Boolean(disconnected),
    channelId: entry.channelId,
    clientId: normalizeClientId(clientId),
    activeClients: entry.runtime.clientCount()
  };
};

WsHubManagerPort.sendMessageAdapter = async function sendMessageAdapter({
  manager,
  channelId,
  clientId,
  message = null,
  metadata = {},
  isBinary = null
}) {
  const entry = getChannelEntry(manager, channelId);
  if (!entry) {
    return createChannelNotFoundResponse(channelId);
  }

  entry.lastActiveAt = Date.now();
  return entry.runtime.sendMessage({
    clientId,
    message,
    metadata,
    isBinary
  });
};

WsHubManagerPort.broadcastMessageAdapter = async function broadcastMessageAdapter({
  manager,
  channelId,
  clientIds = null,
  message = null,
  metadata = {},
  isBinary = null
}) {
  const entry = getChannelEntry(manager, channelId);
  if (!entry) {
    return createChannelNotFoundResponse(channelId);
  }

  entry.lastActiveAt = Date.now();
  return entry.runtime.broadcastMessage({
    clientIds,
    message,
    metadata,
    isBinary
  });
};

WsHubManagerPort.listChannelsAdapter = async function listChannelsAdapter({
  manager,
  appId = null,
  channelPrefix = null
}) {
  const normalizedAppId = normalizeAppId(appId);
  const normalizedChannelPrefix = normalizeChannelPrefix(channelPrefix);

  return [...(manager?.channelEntries?.keys?.() ?? [])]
    .filter((channelId) => matchesAppScope(channelId, normalizedAppId))
    .filter((channelId) => matchesChannelPrefix(channelId, normalizedChannelPrefix))
    .sort();
};

WsHubManagerPort.listClientsAdapter = async function listClientsAdapter({
  manager,
  channelId
}) {
  const entry = getChannelEntry(manager, channelId);
  if (!entry) return [];
  return entry.runtime.listClients();
};

WsHubManagerPort.getClientAdapter = async function getClientAdapter({
  manager,
  channelId,
  clientId
}) {
  const entry = getChannelEntry(manager, channelId);
  if (!entry) return null;
  return entry.runtime.getClient({ clientId });
};

WsHubManagerPort.destroyAdapter = async function destroyAdapter({
  manager
} = {}) {
  if (!manager?.channelEntries) return;

  for (const entry of manager.channelEntries.values()) {
    clearIdleTimer(entry);
    entry.runtime.destroy();
  }
  manager.channelEntries.clear();
};

module.exports = WsHubManagerPort;
Object.freeze(module.exports);

function ensureChannelEntry(manager, channelId, invariantMetadata = null) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) {
    throw new Error(`wsHubManager requires a non-empty channelId`);
  }

  const existing = manager.channelEntries.get(normalizedChannelId) ?? null;
  if (existing) {
    return {
      entry: existing,
      created: false
    };
  }

  const entry = {
    channelId: normalizedChannelId,
    runtime: new WsRoomChannel({
      channelId: normalizedChannelId
    }),
    invariantMetadata: normalizeInvariantMetadata(invariantMetadata),
    idleTimer: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
  manager.channelEntries.set(normalizedChannelId, entry);
  return {
    entry,
    created: true
  };
}

function getChannelEntry(manager, channelId) {
  const normalizedChannelId = normalizeChannelId(channelId);
  if (!normalizedChannelId) return null;
  return manager?.channelEntries?.get(normalizedChannelId) ?? null;
}

function scheduleIdleDestroy(manager, entry) {
  clearIdleTimer(entry);
  const idleMs = normalizeIdleMs(manager?.config?.idleChannelCloseMs, 30_000);
  if (idleMs <= 0) {
    entry.runtime.destroy();
    manager.channelEntries.delete(entry.channelId);
    return;
  }

  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.runtime.clientCount() > 0) return;
    entry.runtime.destroy();
    manager.channelEntries.delete(entry.channelId);
  }, idleMs);
  entry.idleTimer.unref?.();
}

function clearIdleTimer(entry) {
  if (!entry?.idleTimer) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

function normalizeIdleMs(value, defaultValue) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return defaultValue;
  }
  return normalized;
}

function normalizeChannelId(channelId) {
  if (typeof channelId !== `string`) return null;
  const normalized = channelId.trim();
  return normalized || null;
}

function normalizeClientId(clientId) {
  if (typeof clientId !== `string`) return null;
  const normalized = clientId.trim();
  return normalized || null;
}

function normalizeMetadata(metadata) {
  return metadata && typeof metadata === `object`
    ? cloneJsonValue(metadata)
    : {};
}

function extractChannelInvariantMetadata(metadata) {
  const route = metadata?.route && typeof metadata.route === `object`
    ? cloneJsonValue(metadata.route)
    : null;
  return normalizeInvariantMetadata({
    tenantId: metadata?.tenantId ?? route?.origin?.tenantId ?? null,
    appId: metadata?.appId ?? route?.origin?.appId ?? null,
    path: metadata?.path ?? null,
    wsActionsRootFolder: route?.folders?.wsActionsRootFolder ?? null,
    wsActionsAvailable: route?.wsActionsAvailable
      ?? route?.upgrade?.wsActionsAvailable
      ?? null,
    route
  });
}

function normalizeInvariantMetadata(invariantMetadata = null) {
  if (!invariantMetadata || typeof invariantMetadata !== `object`) return null;
  return Object.freeze({
    tenantId: typeof invariantMetadata.tenantId === `string` && invariantMetadata.tenantId.trim()
      ? invariantMetadata.tenantId.trim().toLowerCase()
      : null,
    appId: typeof invariantMetadata.appId === `string` && invariantMetadata.appId.trim()
      ? invariantMetadata.appId.trim().toLowerCase()
      : null,
    path: typeof invariantMetadata.path === `string` && invariantMetadata.path.trim()
      ? invariantMetadata.path.trim()
      : null,
    wsActionsRootFolder: typeof invariantMetadata.wsActionsRootFolder === `string` && invariantMetadata.wsActionsRootFolder.trim()
      ? invariantMetadata.wsActionsRootFolder.trim()
      : null,
    wsActionsAvailable: normalizeStringList(invariantMetadata.wsActionsAvailable),
    route: invariantMetadata.route && typeof invariantMetadata.route === `object`
      ? cloneJsonValue(invariantMetadata.route)
      : null
  });
}

function areChannelMetadataCompatible(existingMetadata, nextMetadata) {
  const left = normalizeInvariantMetadata(existingMetadata);
  const right = normalizeInvariantMetadata(nextMetadata);
  if (!left || !right) return true;
  return JSON.stringify({
    tenantId: left.tenantId,
    appId: left.appId,
    path: left.path,
    wsActionsRootFolder: left.wsActionsRootFolder,
    wsActionsAvailable: left.wsActionsAvailable
  }) === JSON.stringify({
    tenantId: right.tenantId,
    appId: right.appId,
    path: right.path,
    wsActionsRootFolder: right.wsActionsRootFolder,
    wsActionsAvailable: right.wsActionsAvailable
  });
}

function normalizeStringList(value) {
  if (value == null) return null;
  const normalized = (Array.isArray(value) ? value : [value])
    .map((entry) => String(entry ?? ``).trim())
    .filter(Boolean);
  return normalized.length > 0
    ? Object.freeze([...new Set(normalized)])
    : null;
}

function cloneJsonValue(value) {
  if (value == null) return value ?? null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
}

function randomSessionId() {
  return require(`node:crypto`).randomBytes(24).toString(`hex`);
}

function closeSocket(ws) {
  try {
    ws?.close?.();
  } catch { }
}

function normalizeAppId(appId) {
  if (typeof appId !== `string`) return null;
  const normalized = appId.trim().toLowerCase();
  return normalized || null;
}

function normalizeChannelPrefix(channelPrefix) {
  if (typeof channelPrefix !== `string`) return null;
  const normalized = channelPrefix.trim();
  return normalized || null;
}

function matchesAppScope(channelId, appId) {
  if (!appId) return true;
  return String(channelId).startsWith(`${appId}:`);
}

function matchesChannelPrefix(channelId, channelPrefix) {
  if (!channelPrefix) return true;
  return String(channelId).startsWith(channelPrefix);
}

function createChannelNotFoundResponse(channelId) {
  return {
    success: false,
    reason: `channel_not_found`,
    channelId: normalizeChannelId(channelId)
  };
}
