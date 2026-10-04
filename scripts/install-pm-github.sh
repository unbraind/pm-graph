#!/usr/bin/env bash
# Install the same verified project extension in CI and the disabled sync job.
set -euo pipefail

pm_github_version=2026.10.4
./node_modules/.bin/pm package install "npm:pm-github@${pm_github_version}" --project
node -e 'if (require("./.agents/pm/extensions/pm-github/package.json").version !== process.argv[1]) process.exit(1)' "${pm_github_version}"

managed_registry=".agents/pm/extensions/.managed-extensions.json"
if git ls-files --error-unmatch "${managed_registry}" > /dev/null 2>&1; then
  git restore -- "${managed_registry}"
else
  rm -f "${managed_registry}"
fi
