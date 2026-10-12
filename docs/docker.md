# Docker remote login (deployment candidate)

These files are not yet runtime-verified. The development machine currently
has no Docker executable. They provide the plugin CLI and a remote desktop,
not a standalone HTTP API and not a preinstalled Magpie gateway.

## Local validation

Create an external password file with restrictive permissions, and set
`VNC_PASSWORD_FILE` to its absolute path. Do not put credentials in this repo.
Classic VNC uses only the first eight password characters; VNC authentication
alone is insufficient for a public deployment.

```sh
docker compose config
## From a source checkout, first synchronize the packaged build:
npm run build
docker compose up --build -d browser
docker compose exec browser node dist/cli.js login --options /app/docker/options.json
```

Open http://127.0.0.1:6080/vnc.html, connect using the password, and complete
ChatGPT login in the displayed browser. The login command prints the profile
UUID and waits up to fifteen minutes. Resume a timed-out login with
`login --profile UUID --options /app/docker/options.json` in the same container.

```sh
docker compose exec browser node dist/cli.js doctor --options /app/docker/options.json
docker compose exec browser node dist/cli.js chat --options /app/docker/options.json --prompt 'Reply with exactly: ok'
```

The profile volume persists across restarts. `docker compose down -v` deletes
that login state. Only request tabs are closed; the dedicated browser stays
open during the container lifetime. The healthcheck tests noVNC HTTP reachability,
not browser login, WebSocket operation or ChatGPT generation.

## Cloudflare deployment

Before starting the tunnel, configure a Cloudflare Access self-hosted application
for a dedicated login hostname with an explicit allowlist and authentication.
Create a named tunnel whose published application routes that hostname to
`http://browser:6080`. Mount its token using the external file named by
`CLOUDFLARE_TUNNEL_TOKEN_FILE`.

```sh
docker compose --profile tunnel up -d
```

Open `https://YOUR_LOGIN_HOSTNAME/vnc.html`. Verify Access rejects an unauthorized
browser before using any account credentials. Do not publish VNC port 5900 or
Chrome debugging ports. Do not use an unprotected quick tunnel for login.
Set `remoteLoginUrl` to this HTTPS URL in the CLI options file or Magpie plugin
options to include the desktop link in login, resume, guest and Cookie prompts.
This setting does not launch a tunnel or prove its Access policy is enabled.
URLs containing credentials, query strings or fragments are rejected.
Tunnel inbound routing does not change the container's outbound network to
ChatGPT or resolve upstream verification requirements.

## Magpie deployment boundary

An optional co-located gateway target now includes the Magpie executable from
`MAGPIE_IMAGE` (default `ghcr.io/yetone/magpie:latest`) and supervises it alongside
the desktop. Pin this image to a tested version or digest before production.
This target has not been built or run in the current environment.

```sh
docker compose -f compose.yaml -f compose.gateway.yaml config
docker compose -f compose.yaml -f compose.gateway.yaml up --build -d browser
docker compose exec browser magpie plugin add /app
docker compose exec browser magpie plugin login chatgpt-web
```

Set plugin options in Magpie to use `profilesDir: /data/profiles`, visible
`keep-open` mode and your protected `remoteLoginUrl`. The Docker CLI options
file does not automatically configure Magpie. Use Magpie's Web UI on host
loopback port 3430 to manage options. The gateway target runs `magpie web` with
gateway mode; use the per-run Web UI key printed in container logs to open it.
Treat that link as an administrative credential, not an API gateway key.
Gateway and Web UI ports remain loopback;
protect any tunnel routes for them separately from the desktop route. Create
and use Magpie gateway keys before allowing external API traffic.

Magpie's first plugin use may download Bun and dependencies and therefore
requires outbound access. Gateway state, Bun cache and browser profiles live
on durable volumes. The current healthcheck still tests only noVNC; verify
`docker compose exec browser magpie healthcheck` independently.

The existing plugin starts its worker and browser in its own execution
environment. It cannot yet connect from a separate Magpie container to this
browser container as an arbitrary remote CDP service. The CLI association also
does not automatically become a Magpie account. Full deployment must either
run Magpie and the plugin in the same browser/display environment, or implement
and verify a dedicated remote worker transport with account isolation.

The candidate runs as an unprivileged user and does not request privileged mode
or an unconfined seccomp profile. Browser sandbox availability must be verified
on the target Docker runtime; do not silently disable it to hide startup errors.
