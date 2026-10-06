# Isolated environment for CS 2.8.0 verification commands (sourced by run.sh)
export E=$HOME/cs280-claude-cloud/20261006T033701Z
export ST=$HOME/cs280-state
export REPO=/home/user/repo
export PATH=$ST/bin:/opt/node24/bin:$PATH
export COREPACK_HOME=$ST/corepack
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export TMPDIR=$ST/tmp TEMP=$ST/tmp TMP=$ST/tmp
export XDG_CONFIG_HOME=$ST/xdg-config XDG_DATA_HOME=$ST/xdg-data XDG_STATE_HOME=$ST/xdg-state XDG_CACHE_HOME=$ST/xdg-cache
export CLAUDE_PLUGIN_DATA=$ST/claude-plugin-data PLUGIN_DATA=$ST/plugin-data
export npm_config_store_dir=$ST/pnpm-store
export AGENT_GOVERNANCE_SHARED_STATE_DIR=$ST/shared-state
export CODEX_HOME=$ST/codex-home
# Real Cloud session wake port must not be reachable from product code/tests.
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN
