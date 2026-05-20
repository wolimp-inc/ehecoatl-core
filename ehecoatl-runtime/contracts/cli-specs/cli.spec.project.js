// ehecoatl-runtime/contracts/cli-specs/cli.spec.project.js


'use strict';


const { group, projectRoot, projectAppRoot } = require(`../context.js`);
const sharedSpec = require(`./cli.spec.shared.js`);

const cloneCommand = (commandName, overrides = {}) => ({
  ...sharedSpec.COMMANDS.find((commandContract) => commandContract.command === commandName),
  ...overrides
});

module.exports = {
  ABOUT: {
    label: `Project CLI command spec`,
    description: `Project-scoped command surface isolated to one project for app deployment plus project-level config and extensions, with optional explicit @domain target override`,
    contractClass: `SERVICE.CLI.SPEC`
  },
  prefix: `project`,
  groupsAllowed: [
    `root`,
    group.projectScope
  ],
  COMMANDS: [
    {
      command: `deploy app`,
      old_command: null,
      PARAMS: [
        {
          prefix: null,
          optional: false,
          default: null,
          description: `app name to create inside the selected project`,
          shapes: [`{app_name}`]
        },
        {
          prefix: [`-a`, `--app-kit`],
          optional: false,
          default: null,
          description: `app kit folder or zip source to scaffold into the new app environment; the .zip extension is optional; missing kits fall back to customAppKits and https://github.com/ehecoatl/app-kit-{kit_name}.git`,
          shapes: [`{kit_name}`]
        }
      ],
      AFTER_CLI: {
        description: `executed after this command, in this case for director registry refresh`,
        COMMANDS: [
          `ehecoatl core rescan projects`
        ]
      },
      ABOUT: {
        label: `Create and register a new app environment`,
        description: `Creates a new app environment inside the selected project using an app kit`
      }
    },
    {
      command: `delete app`,
      old_command: null,
      PARAMS: [
        {
          prefix: null,
          optional: false,
          default: null,
          description: `app name to remove from the selected project`,
          shapes: [`{app_name}`]
        }
      ],
      ABOUT: {
        label: `Delete an app from the selected project`,
        description: `Removes a previously deployed app environment from the selected project`
      }
    },
    {
      command: `list`,
      old_command: null,
      PARAMS: [],
      ABOUT: {
        label: `List apps in the current project`,
        description: `Returns the apps currently registered inside the selected project; project commands may also be prefixed with @domain after the project scope`
      }
    },
    {
      command: `enable`,
      old_command: null,
      PARAMS: [],
      ABOUT: {
        label: `Enable current project`,
        description: `Marks the current project as enabled`
      }
    },
    {
      command: `disable`,
      old_command: null,
      PARAMS: [],
      ABOUT: {
        label: `Disable current project`,
        description: `Marks the current project as disabled`
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
        label: `Create a new project extension resource`,
        description: `Creates a project-shared plugin inside the current project`
      }
    },
    cloneCommand(`status`, {
      ABOUT: {
        label: `Inspect project status`,
        description: `Returns status details for the current project resolved from the working directory`
      }
    }),
    cloneCommand(`log`, {
      ABOUT: {
        label: `Inspect project logs`,
        description: `Returns log output for the current project resolved from the working directory`
      }
    }),
    cloneCommand(`config`, {
      ABOUT: {
        label: `Get or set project configuration`,
        description: `Reads or updates keys in the current project config.json resolved from the working directory`
      }
    })
  ]
};
