---
name: Native SQLite runtime
description: Compatibility guidance for the project's better-sqlite3 dependency and Replit Node runtime.
---

The native SQLite package must be compiled for the Node ABI used by the active Replit workflow. Prefer a better-sqlite3 release that supports the configured Node version, then reinstall through the project package manager after changing the version.

**Why:** A binary built for a different Node runtime can fail with a process-level segmentation fault before Express starts, which looks like a workflow problem rather than a normal dependency error.

**How to apply:** If the workflow starts with a native-module crash, check `node -v`, the workflow's Node module, and the installed better-sqlite3 compatibility before changing application code.