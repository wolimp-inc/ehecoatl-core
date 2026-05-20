// ehecoatl-runtime/contracts/cli-specs/cli.spec.app.js


'use strict';


const { group } = require(`../context.js`);
const sharedSpec = require(`./cli.spec.shared.js`);

const cloneCommand = (commandName, overrides = {}) => ({
  ...sharedSpec.COMMANDS.find((commandContract) => commandContract.command === commandName),
  ...overrides
});

module.exports = {
  ABOUT: {
    label: `App CLI command spec`,
    description: `App-scoped command surface isolated to one current app environment, with an optional explicit <app_name>@<domain>|<project_id> target override; legacy tenant ids remain accepted`,
    contractClass: `SERVICE.CLI.SPEC`
  },
  prefix: `app`,
  groupsAllowed: [
    `root`,
    group.appScope
  ],
  COMMANDS: [
    {
      command: `enable`,
      old_command: null,
      PARAMS: [],
      ABOUT: {
        label: `Enable current app`,
        description: `Marks the selected app environment as enabled`
      }
    },
    {
      command: `disable`,
      old_command: null,
      PARAMS: [],
      ABOUT: {
        label: `Disable current app`,
        description: `Marks the selected app environment as disabled`
      }
    },
    {
      command: `make`,
      old_command: null,
      PARAMS: [
        {
          prefix: [`middleware`, `plugin`, `action`],
          optional: false,
          default: null,
          description: `resource type to create followed by its name`,
          shapes: [`{new_resource_name}`]
        }
      ],
      ABOUT: {
        label: `Create a resource in the current app`,
        description: `Creates a middleware, plugin, or action inside the selected app environment`
      }
    },
    cloneCommand(`status`, {
      PARAMS: [],
      ABOUT: {
        label: `Inspect current app status`,
        description: `Returns status details for the selected app environment resolved from the working directory or an explicit target`
      }
    }),
    cloneCommand(`log`, {
      PARAMS: [],
      ABOUT: {
        label: `Inspect current app logs`,
        description: `Returns log output for the selected app environment resolved from the working directory or an explicit target`
      }
    }),
    cloneCommand(`config`, {
      PARAMS: [
        {
          prefix: [`--get`],
          optional: true,
          default: null,
          description: `configuration key to read from the current app`,
          shapes: [`{key}`]
        },
        {
          prefix: [`--set`],
          optional: true,
          default: null,
          description: `configuration key to assign on the current app`,
          shapes: [`{key}`]
        },
        {
          prefix: null,
          optional: true,
          default: null,
          description: `configuration value used with --set`,
          shapes: [`"{value}"`]
        }
      ],
      ABOUT: {
        label: `Get or set current app configuration`,
        description: `Reads or updates keys in the selected app config.json`
      }
    })
  ]
};
