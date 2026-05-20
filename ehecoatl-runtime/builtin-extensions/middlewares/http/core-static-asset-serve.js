'use strict';

const { createTenantFacingErrorResponse } = require(`@/utils/http/tenant-facing-error-response`);
const { createStaticAssetInternalRedirect } = require(`./_static-stream-support`);
const {
  resolveI18nSourcePaths,
  resolveRenderableContentType
} = require(`./_template-render-support`);

module.exports = async function runMiddleware(middlewareContext, next) {
  const forward = createFlowController(next);
  const { projectRoute } = middlewareContext;
  if (!projectRoute.isStaticAsset()) {
    return forward.continue();
  }

  const assetPath = projectRoute.assetPath();
  const eRendererRuntime = middlewareContext?.services?.eRendererRuntime ?? null;
  if (eRendererRuntime?.isCompatibleTemplate?.(assetPath)) {
    const exists = await middlewareContext?.services?.storage?.fileExists?.(assetPath).catch(() => false);
    if (!exists) {
      applyResponse(middlewareContext, createTenantFacingErrorResponse({
        status: 404,
        productionBody: `Not Found`,
        nonProductionBody: `Static asset route resolved, but the target file was not found in this non-production environment.`,
        nonProductionDetails: [
          `Asset path: ${assetPath}`
        ]
      }));
      return forward.break();
    }

    const i18nJSONSources = resolveI18nSourcePaths(
      projectRoute?.folders?.rootFolder ?? ``,
      projectRoute?.i18n ?? [],
      { entryLabel: `Route i18n` }
    );
    const renderedStream = await eRendererRuntime.renderView(assetPath, i18nJSONSources, {
      request: middlewareContext?.requestData ?? null,
      session: middlewareContext?.sessionData ?? null,
      route: projectRoute ?? null,
      meta: middlewareContext?.meta ?? null,
      view: middlewareContext?.viewData ?? {}
    });
    const contentType = resolveRenderableContentType(assetPath);
    if (contentType) {
      middlewareContext.setHeader(`Content-Type`, contentType);
    }
    middlewareContext.setBody(renderedStream);
    return forward.break();
  }

  const internalRedirect = await createStaticAssetInternalRedirect(middlewareContext, assetPath);
  if (internalRedirect) {
    middlewareContext.setBody(internalRedirect);
    return forward.break();
  }

  applyResponse(middlewareContext, createTenantFacingErrorResponse({
    status: 404,
    productionBody: `Not Found`,
    nonProductionBody: `Static asset route resolved, but the target file was not found in this non-production environment.`,
    nonProductionDetails: [
      `Asset path: ${assetPath}`
    ]
  }));
  return forward.break();
};

function applyResponse(middlewareContext, response) {
  middlewareContext.setStatus(response.status);
  middlewareContext.setBody(response.body);

  for (const [key, value] of Object.entries(response.headers ?? {})) {
    middlewareContext.setHeader(key, value);
  }
}

function createFlowController(next) {
  const hasNext = typeof next === `function`;
  return Object.freeze({
    continue: () => hasNext ? next() : true,
    break: () => hasNext ? undefined : false
  });
}
