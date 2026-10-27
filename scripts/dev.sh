#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [ -f /workspace/.cloud-tools/chatbot-env.sh ]; then
  source /workspace/.cloud-tools/chatbot-env.sh
fi
export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"
exec python3 "$script_dir/dev.py" "$@"
