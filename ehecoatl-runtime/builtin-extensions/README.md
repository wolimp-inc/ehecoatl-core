# Extensions

`builtin-extensions/` contains packaged extension material that ships with the runtime.

## Main Areas

- `adapters/`
  Bundled adapter implementations for adaptable runtime components.
- `plugins/`
  Packaged plugins that extend runtime behavior through hooks.
- `middlewares/`
  Packaged middleware surfaces used by the runtime and starter kits.
- `project-kits/`
  Tenant scaffolds used by deploy flows.
- `app-kits/`
  Application scaffolds and runnable examples used by deploy flows.

## Purpose

This folder is the packaged extension surface for the installed runtime. It is distinct from tenant-local customization under deployed tenant and app directories.

## What Does Not Belong Here

- Host install logic
- Core runtime kernels and internal coordination
- Generated tenant or app deployment content outside the packaged kits
