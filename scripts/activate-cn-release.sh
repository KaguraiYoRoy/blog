#!/usr/bin/env bash
set -euo pipefail
umask 022

fail() {
    printf 'Deployment failed: %s\n' "$1" >&2
    exit 1
}

[[ $# == 3 || $# == 4 ]] || fail 'Expected deployment directory, release ID, SHA-256 checksum, and optional link name'
[[ $1 == /* ]] || fail 'Deployment directory must be absolute'
deploy_root=$(realpath -m -- "$1")
release_id=$2
checksum=$3
link_name=${4:-current}
[[ $deploy_root != / ]] || fail 'Cannot deploy to the filesystem root'
[[ $release_id =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ ]] || fail 'Invalid release ID'
[[ $checksum =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid SHA-256 checksum'
[[ $link_name =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]*$ && $link_name != incoming && $link_name != releases ]] \
    || fail 'Invalid web root link name'

mkdir -p -- "$deploy_root/releases" "$deploy_root/incoming"
exec 9> "$deploy_root/.deploy.lock"
flock -w 60 9 || fail 'Another deployment is still running'

archive="$deploy_root/incoming/$release_id.tar"
release_dir="$deploy_root/releases/$release_id"
web_root="$deploy_root/$link_name"
pending_link="$deploy_root/.pending-$release_id"

[[ -f $archive ]] || fail 'Uploaded archive is missing'
[[ ! -e $release_dir && ! -L $release_dir ]] || fail 'Release ID already exists'
[[ ! -e $web_root || -L $web_root ]] \
    || fail 'The web root path already exists and is not a symlink'
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status \
    || fail 'Uploaded archive checksum does not match'

mkdir -- "$release_dir"
activated=false
cleanup() {
    rm -f -- "$pending_link" "$archive"
    if [[ $activated != true ]]; then
        rm -rf -- "$release_dir"
    fi
}
trap cleanup EXIT

tar --extract --file "$archive" --directory "$release_dir" \
    --no-same-owner --no-same-permissions
[[ -s "$release_dir/index.html" && -s "$release_dir/pagefind/pagefind.js" && -d "$release_dir/_astro" ]] \
    || fail 'Archive must contain the homepage, Astro assets, and Pagefind search index'
chmod -R u=rwX,go=rX -- "$release_dir"

# Rename the link on the same filesystem so the web root changes atomically.
ln -s -- "releases/$release_id" "$pending_link"
mv -Tf -- "$pending_link" "$web_root"
activated=true
printf 'Activated release %s. Previous releases were retained.\n' "$release_id"
