#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${HOME}/.local/bin"
node_executable="${PI_NODE_EXE:-${HOME}/AppData/Local/pi-node/current/node.exe}"

mkdir -p "${install_dir}"
cp "${root}/src/core.mjs" "${install_dir}/core.mjs"
cp "${root}/src/github-app.mjs" "${install_dir}/github-app.mjs"
cat > "${install_dir}/github-app" <<EOF
#!/usr/bin/env bash
exec "${node_executable}" "${install_dir}/github-app.mjs" "\$@"
EOF
chmod 755 "${install_dir}/github-app" "${install_dir}/github-app.mjs" "${install_dir}/core.mjs"

echo "Installed github-app in ${install_dir}"
