// ehecoatl-runtime/contracts/context.js


'use strict';


const service = `ehecoatl`;

const serviceInstallRoot = `/opt/${service}`;
const serviceOverrideRoot = `/etc/opt/${service}`;
const builtinExtensionsRoot = `/opt/${service}/extensions`;
const serviceVarRoot = `/var/opt/${service}`;
const serviceLibRoot = `/var/lib/${service}`;
const serviceLogRoot = `/var/log/${service}`;
const serviceSrvRoot = `/srv/opt/${service}`;
const serviceProjectsRoot = `/var/opt/${service}/projects`;
const serviceTenantsRoot = `/var/opt/${service}/tenants`;

const projectRoot = `${serviceProjectsRoot}/project_{tenant_domain}`;
const tenantRoot = `${serviceTenantsRoot}/tenant_{tenant_domain}`;
const legacyTenantRoot = tenantRoot;
const appRoot = `${tenantRoot}/app_{app_name}`;
const projectAppRoot = `${projectRoot}/app_{app_name}`;

const group = {
  internalScope: service,
  superScope: `g_superScope`,
  directorScope: `g_directorScope`,
  projectScope: `g_{tenant_id}`,
  tenantScope: `g_{tenant_id}`,
  appScope: `g_{tenant_id}_{app_id}`
};

const user = {
  internalUser: service,
  supervisorUser: `u_supervisor`,
  projectUser: `u_project_{tenant_id}`,
  tenantUser: `u_tenant_{tenant_id}`,
  appUser: `u_app_{tenant_id}_{app_id}`
};

module.exports = {
  service,
  serviceInstallRoot,
  serviceOverrideRoot,
  serviceProjectsRoot,
  serviceTenantsRoot,
  serviceVarRoot,
  serviceLibRoot,
  serviceLogRoot,
  serviceSrvRoot,
  projectRoot,
  tenantRoot,
  legacyTenantRoot,
  appRoot,
  projectAppRoot,
  builtinExtensionsRoot,
  user,
  group
};

Object.freeze(module.exports);
