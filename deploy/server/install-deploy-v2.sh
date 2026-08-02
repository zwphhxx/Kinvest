#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="${1:-}"
LOCAL_DEPLOY_SCRIPT='/usr/local/sbin/deploy-kinvest'
LOCAL_SSH_COMMAND='/usr/local/sbin/kinvest-ssh-command'

if [[ "$#" -ne 1 || "$SOURCE_DIR" != /* || ! -d "$SOURCE_DIR" ]]; then
  printf '%s\n' 'usage: install-deploy-v2.sh /absolute/canonical/source/dir' >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' 'deploy-v2 installation must run as root' >&2
  exit 1
fi

if [[ "$(realpath -e -- "$SOURCE_DIR")" != "$SOURCE_DIR" ]]; then
  printf '%s\n' 'deploy-v2 source directory must be canonical' >&2
  exit 2
fi

for source_file in deploy-kinvest-v2.sh kinvest-ssh-command-v2; do
  if [[ ! -f "$SOURCE_DIR/$source_file" || -L "$SOURCE_DIR/$source_file" ]]; then
    printf '%s\n' "invalid deploy-v2 source file: $source_file" >&2
    exit 1
  fi
  bash -n "$SOURCE_DIR/$source_file"
done

for target in "$LOCAL_DEPLOY_SCRIPT" "$LOCAL_SSH_COMMAND"; do
  if [[ -L "$target" ]]; then
    printf '%s\n' "refusing symlinked deploy-v2 target: $target" >&2
    exit 1
  fi
done

deploy_temporary="$(mktemp /usr/local/sbin/.deploy-kinvest-v2.XXXXXX)"
wrapper_temporary="$(mktemp /usr/local/sbin/.kinvest-ssh-command-v2.XXXXXX)"
cleanup() {
  rm -f -- "$deploy_temporary" "$wrapper_temporary"
}
trap cleanup EXIT INT TERM HUP
on_signal() {
  exit "$1"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

install -o root -g root -m 0755 -- "$SOURCE_DIR/deploy-kinvest-v2.sh" "$deploy_temporary"
install -o root -g root -m 0755 -- "$SOURCE_DIR/kinvest-ssh-command-v2" "$wrapper_temporary"
bash -n "$deploy_temporary"
bash -n "$wrapper_temporary"

# Install the root program first. Until the wrapper is replaced, an old two-line
# request fails closed against the v2 envelope. No deployment is started here.
mv -f -- "$deploy_temporary" "$LOCAL_DEPLOY_SCRIPT"
deploy_temporary=''
mv -f -- "$wrapper_temporary" "$LOCAL_SSH_COMMAND"
wrapper_temporary=''

sha256sum "$LOCAL_DEPLOY_SCRIPT" "$LOCAL_SSH_COMMAND"
printf '%s\n' 'deploy-v2 entrypoint installed; no container was restarted.'
