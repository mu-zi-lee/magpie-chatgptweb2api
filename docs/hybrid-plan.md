# Hybrid browser and internal-interface implementation plan

Status: implementation in progress. The Docker files are an initial deployment
candidate, not a verified container release. Browser text remains the only
implemented generation transport. No direct internal-interface generation
fallback is enabled by default. An opt-in internal reader is implemented for exact-turn
reconciliation; it does not send messages and is disabled by default.

An experimental `internalSender` now attempts a same-origin conversation POST
only when the DOM composer or send button is absent and the configured model has an explicit
`backendSlug`. Preflight declines without POST when challenges are required.
Only that pre-POST decline allows page reload and a recovered DOM send. A POST
timeout, malformed stream, partial response or navigation is an unknown
submission and never authorizes resend. This initial adapter only understands
full-message SSE snapshots, not newer delta encodings; live compatibility is
unverified. Its output is buffered, not incremental.

## Requirements and interpretation

The requested order is interpreted as an existing visible dedicated browser,
then an internal-interface path, then browser recovery. The first and third
browser paths must have distinct roles: reuse versus reconnect/recovery.
This interpretation still needs user confirmation.

Remote login must operate the same dedicated browser and persistent profile
that serves requests. Docker provides a virtual display; noVNC provides remote
keyboard, pointer and video; Cloudflare Tunnel provides connectivity, not
ChatGPT authentication and not challenge bypass.

## Reference evidence

Sources read on 2026-10-11:

- https://github.com/Octo-Lex/ChatGPT-Web2API/blob/master/src/chatgpt_web2api/cdp_driver.py
  Dedicated target ownership, readiness probes, generation-stall classification,
  reconnection and no automatic resend after an uncertain submission.
- https://github.com/Octo-Lex/ChatGPT-Web2API/blob/master/src/chatgpt_web2api/backend_client.py
  Browser-context internal requests and submitted-turn correlation. Backend
  completion reads must resolve the submitted user node, not the latest assistant.
- https://github.com/poelzi/CatGPT-Gateway/blob/main/docker/supervisord.conf
  Xvfb, VNC and websockify/noVNC supervised inside a container.
- https://github.com/poelzi/CatGPT-Gateway/blob/main/src/chatgpt/client.py
  DOM sending and file input handling. Its timeout-to-extraction behavior is not
  suitable for this plugin's explicit-completion guarantee.
- https://github.com/lanqian528/chat2api/blob/main/chatgpt/ChatService.py
  Direct internal conversation requests and protocol conversion. Challenge
  solvers, token logging and quota circumvention are not adopted.
- https://developers.openai.com/siwc/quickstart
  Official documentation now describes open-source ChatGPT plan usage through
  separately authorized Responses API scopes. This is a separate supported
  integration candidate, not permission to reuse browser session tokens for
  arbitrary API calls. Eligibility and registration must be checked before use.

These are design references. Their claims and tests do not establish live
ChatGPT compatibility for this plugin. This implementation does not copy their
source code.

## Planned modules

1. Browser session: persistent dedicated profile, visible login, CDP connection,
   owned request tabs, cross-process account lock and identity checks.
2. Request routing: explicit submission state (not attempted, attempted,
   confirmed, completed). An attempted send cannot fall through to another send.
3. Internal reader: same-origin browser-context fetch, no exported credentials,
   bounded response projection, exact user/assistant ancestry, explicit finish.
   Initially use it for reconciliation of a known submitted turn. Never guess
   correlation from the most recent conversation or matching text alone.
4. Internal sender: experimental and opt-in only after live contract validation.
   A transport timeout or navigation after POST means unknown submission, not
   permission to try a browser send. Authentication, challenge and quota errors
   must not trigger attempts to evade those controls.
5. Recovery: reconnect the same browser and reobserve the same turn. Recreate a
   page only before send or navigate to a known conversation for observation.
6. Diagnostics: readiness stage and error codes without prompt, cookie, token,
   session body or account content in logs. Separate transport health from auth
   health and completed-generation health.
7. Remote login deployment: Xvfb/noVNC, durable profiles and authenticated tunnel.

## Verification gates

- Existing browser and Magpie host tests remain green.
- Routing tests cover every submission state and prove at most one send.
- Internal reader tests cover stale replies, branches, missing identities,
  incomplete replies, authentication errors, quota errors and response bounds.
- Real browser fixtures verify fallback without exporting session tokens.
- Build and start Docker; authenticate to noVNC and log in manually; get a full
  real reply, then restart the container and verify profile reuse.
- Verify protected Cloudflare Access + Tunnel WebSocket operation from outside
  the server. Unauthenticated users must not reach the login desktop.
- Run the actual Magpie host in the deployment environment. A successful CLI
  request alone is not proof of deployed Magpie integration.

No live-account requests or destructive account-management endpoints are run
automatically by development tests.
