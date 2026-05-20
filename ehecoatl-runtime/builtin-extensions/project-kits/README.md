# Project Kits

This folder is the primary home for built-in Project Kits.

Project kits scaffold tenant environments during `ehecoatl core deploy tenant`.
They may include tenant-level shared assets, middleware, configuration, and
top-level `app_<name>/` folders that are promoted into normal apps during
tenant deploy.

Legacy built-in Tenant Kits remain supported from `../tenant-kits` as a
compatibility fallback.
