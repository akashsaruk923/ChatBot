#!/usr/bin/env bash
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
if [ -f /workspace/.cloud-tools/chatbot-env.sh ]; then
  source /workspace/.cloud-tools/chatbot-env.sh
fi
export NG_CLI_ANALYTICS=false
export NG_BUILD_MAX_WORKERS=2
dotnet tool restore
dotnet restore backend/Dadus.sln --locked-mode --verbosity minimal
dotnet build backend/Dadus.sln --no-restore --configuration Release --verbosity minimal -m:2
npm ci --prefix frontend/dadus-web --no-audit --no-fund
CI=true npm --prefix frontend/dadus-web run build -- --configuration production
