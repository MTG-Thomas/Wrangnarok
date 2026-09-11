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
# 6. Before opening a PR: merge origin/main, then run the FULL gate locally
#    and confirm every step green — npm ci, npm run test:coverage (ALL FOUR
#    metrics >= 95: lines, functions, branches, statements; plain `npm test`
#    is NOT enough), npm run typecheck, npm run lint,
#    npm run format:check, npm run build:ui, npm run check:bundle,
#    plus lane-scope clean. A PR opened red wastes a full queue cycle.
