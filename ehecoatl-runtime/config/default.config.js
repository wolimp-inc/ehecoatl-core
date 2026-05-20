// config/default.config.js


'use strict';


module.exports = {
  "_adapters": {},

  "appRpcCli": {
    "defaultTimeoutMs": 10000,
    "maxTimeoutMs": 30000,
    "maxBufferBytes": 262144,
    "apps": {}
  },

  "runtime": {
    "customConfigPath": "/etc/opt/ehecoatl/config", // Future get from runtime policy
    "customProjectKitsPath": "/srv/opt/ehecoatl/project-kits",
    "customTenantKitsPath": "/srv/opt/ehecoatl/tenant-kits",
    "customAdaptersPath": "/srv/opt/ehecoatl/adapters",
    "customPluginsPath": "/srv/opt/ehecoatl/plugins",
    "security": {
      "seccomp": {
        "mode": "enforce"
      }
    },
    "network": {
      "defaultWanBlock": true,
      "wanOpenApps": [],
      "openLocalPorts": [6379, 3306]
    }
  },

  "plugins": {
    "boot-logger": {
      "enabled": true,
      "console": true,
      "fileLogging": {
        "enabled": true,
        "maxFiles": 24,
        "cleanupIntervalMs": 300000
      }
    },

    "runtime-reporter": {
      "enabled": true,
      "fileLogging": {
        "enabled": true,
        "maxFiles": 24, //1 day hourly
        "cleanupIntervalMs": 300000 //5minutes
      },
      "tenantReport": {
        "enabled": true,
        "flushIntervalMs": 5000
      }
    },

    "error-reporter": {
      "enabled": true
    },

    "ObservabilitySurface": {
      "enabled": true,
      "allowedApps": [
        {
          "tenantId": "7vhdq1j8gk4d",
          "appId": "dash01"
        }
      ],
      "questions": {
        "snapshot": "observability.snapshot",
        "processes": "observability.processes",
        "health": "observability.health",
        "reloadProcess": "observability.reloadProcess",
        "shutdownProcess": "observability.shutdownProcess"
      }
    },
  },

  "adapters": {
    "webServerService": {
      "adapter": "nginx", //nginx

      "httpsPort": 443,
      "wssPort": 8443,
      "managedConfigDir": "/etc/nginx/conf.d/ehecoatl",
      "managedIncludeFile": "/etc/nginx/conf.d/ehecoatl.conf",
      "managedConfigPrefix": "project_",
      "defaultProjectKitBaseDir": "/srv/opt/ehecoatl/project-kits",
      "defaultProjectKitName": "empty",
      "defaultTenantKitBaseDir": "/srv/opt/ehecoatl/tenant-kits",
      "defaultTenantKitName": "empty",
      "nginxTestCommand": ["nginx", "-t", "-e", "stderr"],
      "nginxReloadCommand": ["nginx", "-s", "reload"],

      "trust_proxy": true,

      "limiter": {
        "capacity": 100,
        "time": 10
      },
    },

    "ingressRuntime": {
      "adapter": "uws",
      "httpCoreIngressPort": 14000,
      "wsCoreIngressPort": 14001,
      "limiter": {
        "capacity": 100,
        "time": 10
      },
      "question": {
        "requestUriRoutingRuntime": "requestUriRoutingRuntime",
        "setSharedObject": "setSharedObject",
        "getSharedObject": "getSharedObject"
      },
    },

    "certificateService": {
      "adapter": "lets-encrypt",
      "liveBaseDir": "/etc/letsencrypt/live",
      "triggerCooldownMs": 21600000,
      "defaultCertbotEmail": null,
      "certbotIssueCommandTemplate": [
        "certbot",
        "--nginx",
        "--non-interactive",
        "--agree-tos",
        "--keep-until-expiring",
        "-d",
        "{domain}"
      ]
    },

    "rpcRuntime": {
      "adapter": "ipc",
      "askTimeoutMs": 30000,
      "answerTimeoutMs": 30000,
      "localAskTimeoutMs": 120000
    },

    "queueBroker": {
      "adapter": "event-memory",
      "defaultTTL": 1000
    },

    "wsHubManager": {
      "adapter": "local-memory",
      "idleChannelCloseMs": 30000,
      "question": {
        "command": "wsHub"
      }
    },

    "projectDirectoryResolver": {
      "adapter": "default-tenancy",
      "spawnProjectAppAfterScan": true,
      "spawnTenantAppAfterScan": true,
      "processRpcTimeoutMs": 2000,
      "scanActiveCacheKey": "projectScanActive",
      "scanActiveTTL": 30000, //30seconds
      "scanIntervalMs": 300000, //5minutes
      "responseCacheCleanupIntervalMs": 300000, //5minutes
      "projectsPath": "/var/opt/ehecoatl/projects",
      "tenantsPath": "/var/opt/ehecoatl/tenants",
      "question": {
        "forceRescanNow": "projectRescanNow",
        "shutdownProcessNow": "projectShutdownProcessNow"
      }
    },

    "tenantDirectoryResolver": {
      "adapter": "default-tenancy",
      "spawnTenantAppAfterScan": true,
      "processRpcTimeoutMs": 2000,
      "scanActiveCacheKey": "tenancyScanActive",
      "scanActiveTTL": 30000,
      "scanIntervalMs": 300000,
      "responseCacheCleanupIntervalMs": 300000,
      "projectsPath": "/var/opt/ehecoatl/projects",
      "tenantsPath": "/var/opt/ehecoatl/tenants",
      "question": {
        "forceRescanNow": "tenancyRescanNow",
        "shutdownProcessNow": "tenancyShutdownProcessNow"
      }
    },

    "projectRegistryResolver": {
      "adapter": "default-runtime-registry-v1",
      "internalProxyPortStart": 14002,
      "internalProxyPortEnd": 65534
    },

    "tenantRegistryResolver": {
      "adapter": "default-runtime-registry-v1",
      "internalProxyPortStart": 14002,
      "internalProxyPortEnd": 65534
    },

    "projectRouteMatcherCompiler": {
      "adapter": "default-routing-v1"
    },

    "tenantRouteMatcherCompiler": {
      "adapter": "default-routing-v1"
    },

    "i18nCompiler": {
      "adapter": "ehecoatl-default"
    },

    "eRendererRuntime": {
      "adapter": "default-renderer",
      "compatibleFileFormats": [".e.htm", ".e.html", ".e.txt"],
      "markdownEnabled": true,
      "markdownFileFormats": [".md", ".markdown"],
      "maxIncludeDepth": 10,
      "maxLoopIterations": 1000
    },

    "requestUriRoutingRuntime": {
      "adapter": "default-uri-router-runtime",
      "defaultAppName": "www",
      "routeMatchTTL": 60000, //1minute
      "routeMissTTL": 5000,
      "asyncCacheTimeoutMs": 500 //5seconds
    },

    "watchdogOrchestrator": {
      "reloadDrainTimeoutMs": 1000,
      "reloadGracefulExitTimeoutMs": 1500,
      "reloadForceKillFailSafeTimeoutMs": 1000,
      "heartbeat": {
        "timeoutMs": 10000,
        "maxElu": 0.98,
        "maxLagP99Ms": 500,
        "maxLagMaxMs": 1500
      },
      "question": {
        "reloadProcess": "reloadProcess",
        "heartbeat": "heartbeat"
      }
    },

    "processForkRuntime": {
      "adapter": "child-process", // child_process, worker_threads

      "nodeMaxOldSpaceSizeMb": 192,
      "cgroups": {
        "enabled": true,
        "memoryMaxMb": 192,
        "cpuMaxPercent": 50,
        "cleanupIntervalMs": 30000,
        "delegateSubgroup": "supervisor",
        "registryFile": "/var/lib/ehecoatl/registry/managed-cgroups.json"
      },
      "defaultTimeout": 30000,
      "cleanupTaskTimeoutMs": 3000,
      "question": {
        "shutdownProcess": "shutdownProcess",
        "ensureProcess": "ensureProcess",
        "listProcesses": "listProcesses",
        "processCounts": "processCounts"
      }
    },

    "middlewareStackRuntime": {
      "maxInputBytes": "1MB",
      "latencyClassification": {
        "enabled": true,
        "profiles": {
          "staticAsset": { "fastMs": 50, "okMs": 120, "slowMs": 300 },
          "cacheHit": { "fastMs": 30, "okMs": 90, "slowMs": 250 },
          "action": { "fastMs": 150, "okMs": 450, "slowMs": 1200 },
          "default": { "fastMs": 120, "okMs": 350, "slowMs": 900 }
        }
      },
      "diskLimit": {
        "enabled": true,
        "defaultMaxBytes": "10MB",
        "trackedPaths": [".ehecoatl/.cache", ".ehecoatl/log", ".ehecoatl/.spool"],
        "cleanupFirst": true,
        "cleanupTargetRatio": 0.9
      },
      "queue": {
        "perTenantMaxConcurrent": 5,
        "staticMaxConcurrent": 10,
        "actionMaxConcurrent": 5,

        "staticWaitTimeoutMs": 500,
        "actionWaitTimeoutMs": 1000,
        "waitTimeoutMs": 1000,
        "retryAfterMs": 500
      },
      "responseCacheAsyncTimeoutMs": 1500,
      "maxResponseCacheTTL": null, // seconds
      "question": {
        "enqueue": "queue",
        "dequeue": "dequeue",
        "cleanupByOrigin": "queueCleanupByOrigin",
        "tenantAction": "tenantAction",
        "tenantWsAction": "tenantWsAction"
      }
    },

    "storageService": {
      "adapter": "local", // local, s3, gcs
      "s3": {
        "bucket": "ehecoatl-storage",
        "region": "us-east-1"
      }
    },

    "sharedCacheService": {
      "adapter": "local-memory", // local-memory, redis
      "defaultTTL": 3600,
      "failurePolicy": {
        "get": { "failOpen": true, "warn": true },
        "set": { "failOpen": true, "warn": true },
        "delete": { "failOpen": true, "warn": true },
        "deleteByPrefix": { "failOpen": true, "warn": true },
        "has": { "failOpen": true, "warn": true },
        "appendList": { "failOpen": true, "warn": true },
        "getList": { "failOpen": true, "warn": true }
      }
    },
  }
};

Object.freeze(module.exports);
