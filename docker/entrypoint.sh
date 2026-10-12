#!/bin/sh
set -eu
umask 077

if [ ! -s /run/secrets/vnc_auth ]; then
    printf '%s\n' 'Mount a nonempty VNC authentication file at /run/secrets/vnc_auth.' >&2
    exit 1
fi

# Classic VNC authentication only uses eight characters; Access is still required remotely.
vnc_auth=$(cat /run/secrets/vnc_auth)
if [ "${#vnc_auth}" -lt 8 ]; then
    printf '%s\n' 'VNC authentication must contain at least eight characters.' >&2
    exit 1
fi
x11vnc -storepasswd "$vnc_auth" /tmp/magpie-vnc-auth >/dev/null 2>&1
unset vnc_auth

mkdir -p /data/profiles
chmod 700 /data/profiles
exec supervisord -c /app/docker/supervisord.conf
