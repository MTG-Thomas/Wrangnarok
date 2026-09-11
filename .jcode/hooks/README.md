# Jcode hooks for Wrangnarok

#

# Hooks live in the GLOBAL config (`~/.jcode/config.toml`), not in the repo:

# jcode reads `[hooks]` only from the global file. These scripts are

# repo-local so lanes share the same policy; point your global config at

# them with absolute paths.

#

# Add to ~/.jcode/config.toml (Windows paths shown; adjust the checkout root):

#

# [hooks]

# pre_tool = "node C:\\Users\\ThomasBray\\src\\MTG-Thomas\\Wrangnarok\\.jcode\\hooks\\pre-tool-guard.mjs"

# session_end = "node C:\\Users\\ThomasBray\\src\\MTG-Thomas\\Wrangnarok\\.jcode\\hooks\\session-end-checkpoint.mjs"

# pre_tool_timeout_ms = 5000

#

# What each hook does:

#

# - pre-tool-guard.mjs (gate, fails open on error): blocks production-touching

# Wrangler commands from agent sessions — `wrangler deploy` without

# `--dry-run`, `wrangler d1` without `--local`, `wrangler secret put` — and

# blocks agent writes to `.dev.vars` local secret files.

# - session-end-checkpoint.mjs (observer, fire-and-forget): appends one terse

# checkpoint line to `.opencode/goals/overnight-bifrost.md` when a session

# ends so the next session resumes cheaply.
