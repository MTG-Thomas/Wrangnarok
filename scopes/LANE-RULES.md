# Shared rules for all parity lanes.
# Lane briefs must include these verbatim:
# 1. Stay in scope: touch ONLY files listed in your lane's scope file
#    (scopes/<lane>.scope). Run `node scripts/lane-scope.mjs scopes/<lane>.scope`
#    before every commit and before opening a PR; it must print clean.
# 2. Never stage .jcode/skills/, .opencode/skills/, node_modules/, .wrangler/,
#    vendor/ — lane-scope.mjs enforces this even if a scope file is wrong.
# 3. Never force-push a shared lane branch.
# 4. PR standard: `automerge` label AND `@mergifyio queue` comment together
#    at creation.
# 5. Local + CI only. No prod credentials, no prod deploys, no paid-tier moves.
# 6. Before opening a PR: merge origin/main, re-run npm ci + npm test +
#    typecheck + lint, confirm lane-scope clean.
