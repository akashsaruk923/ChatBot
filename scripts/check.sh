#!/usr/bin/env bash
set -euo pipefail
repo_root=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
if [ -f /workspace/.cloud-tools/chatbot-env.sh ]; then
  source /workspace/.cloud-tools/chatbot-env.sh
fi
dotnet test backend/Dadus.sln --no-build --no-restore --configuration Release --verbosity minimal
CI=true NG_CLI_ANALYTICS=false NG_BUILD_MAX_WORKERS=2 npm --prefix frontend/dadus-web test -- --watch=false
