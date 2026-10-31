#!/usr/bin/env bash
set -euo pipefail

fail() {
    printf 'Deployment failed: %s\n' "$1" >&2
    exit 1
}

[[ $# == 2 ]] || fail 'Usage: deploy-cn.sh <artifact.tar> <release-id>'
artifact=$1
release_id=$2

for variable in DEPLOY_CN_HOST DEPLOY_CN_USER DEPLOY_CN_SSH_KEY DEPLOY_CN_KNOWN_HOSTS DEPLOY_CN_PATH; do
    [[ -n ${!variable:-} ]] || fail "Missing GitHub Actions secret: $variable"
done
deploy_port=${DEPLOY_CN_PORT:-22}
link_name=${DEPLOY_CN_LINK_NAME:-current}
[[ $deploy_port =~ ^[0-9]{1,5}$ ]] || fail 'DEPLOY_CN_PORT must be a TCP port number'
(( 10#$deploy_port >= 1 && 10#$deploy_port <= 65535 )) || fail 'DEPLOY_CN_PORT is out of range'
[[ $DEPLOY_CN_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.:%-]*$ ]] || fail 'Invalid DEPLOY_CN_HOST'
[[ $DEPLOY_CN_USER =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || fail 'Invalid DEPLOY_CN_USER'
[[ $DEPLOY_CN_PATH == /* && $DEPLOY_CN_PATH != *$'\n'* && $DEPLOY_CN_PATH != *$'\r'* ]] \
    || fail 'DEPLOY_CN_PATH must be an absolute Linux directory path'
[[ $(realpath -m -- "$DEPLOY_CN_PATH") != / ]] || fail 'DEPLOY_CN_PATH cannot be the filesystem root'
[[ $link_name =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ && $link_name != incoming && $link_name != releases ]] \
    || fail 'DEPLOY_CN_LINK_NAME must be a directory name other than incoming or releases'
[[ $release_id =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail 'Invalid release ID'
[[ -s $artifact ]] || fail 'Build artifact is missing or empty'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
checksum=$(sha256sum -- "$artifact")
checksum=${checksum%% *}

umask 077
ssh_dir=$(mktemp -d)
trap 'rm -rf -- "$ssh_dir"' EXIT
printf '%s\n' "${DEPLOY_CN_SSH_KEY//$'\r'/}" > "$ssh_dir/key"
printf '%s\n' "${DEPLOY_CN_KNOWN_HOSTS//$'\r'/}" > "$ssh_dir/known_hosts"
ssh-keygen -y -P '' -f "$ssh_dir/key" > /dev/null \
    || fail 'DEPLOY_CN_SSH_KEY must be a valid private key without a passphrase'

ssh_options=(
    -i "$ssh_dir/key"
    -p "$deploy_port"
    -l "$DEPLOY_CN_USER"
    -o BatchMode=yes
    -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$ssh_dir/known_hosts"
    -o GlobalKnownHostsFile=/dev/null
    -o ConnectTimeout=20
    -o ConnectionAttempts=3
    -o ServerAliveInterval=15
    -o ServerAliveCountMax=3
    -o LogLevel=ERROR
)

# SSH sends a command string to the remote login shell, so quote each argument.
quote_for_shell() {
    printf "'%s'" "${1//\'/\'\\\'\'}"
}

incoming_dir=$(quote_for_shell "${DEPLOY_CN_PATH%/}/incoming")
remote_archive=$(quote_for_shell "${DEPLOY_CN_PATH%/}/incoming/$release_id.tar")
upload_command="set -eu
umask 077
mkdir -p -- $incoming_dir
cat > $remote_archive"

printf 'Uploading the build artifact for release %s.\n' "$release_id"
# Remote command arguments have already been quoted above.
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$DEPLOY_CN_HOST" "$upload_command" < "$artifact"

activate_command="bash -s -- $(quote_for_shell "$DEPLOY_CN_PATH") $(quote_for_shell "$release_id") $checksum $(quote_for_shell "$link_name")"
# shellcheck disable=SC2029
ssh "${ssh_options[@]}" "$DEPLOY_CN_HOST" "$activate_command" < "$script_dir/activate-cn-release.sh"
