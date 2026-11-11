# TrueOG deployment of WeKan (todo.true-og.net)

How TrueOG runs this fork: Dockerless, under OpenRC, on FerretDB 2.7 over PostgreSQL 17, behind nginx and
Cloudflare, with sign-in only through Staff-Auth (TrueOG's Ory Hydra OpenID Connect provider). Nothing here holds
a secret: values that are secret on the server appear as `<placeholders>`. The working copies live on the server in
`/home/system/gitea-upgrade` (scripts) and `/opt/wekan`, `/etc` (configuration); this folder records them.

| Path | Live location | What it is |
| --- | --- | --- |
| `wekan.env.example` | `/opt/wekan/wekan.env` | Environment, sourced by the OpenRC script. Secrets replaced. |
| `openrc/wekan.initd`, `openrc/wekan.confd` | `/etc/init.d/wekan`, `/etc/conf.d/wekan` | Service; `node=` picks the Node version (26 since WeKan 13.06). |
| `nginx/wekan.conf` | `/etc/nginx/sites-available/wekan.conf` | Reverse proxy; injects the sign-in-page style (below). |
| `authwatch/` | `/usr/local/sbin/trueog-wekan-authwatch.mjs`, `/etc/init.d/trueog-wekan-authwatch`, `/etc/logrotate.d/` | Locks and signs out WeKan accounts when their Staff-Auth sign-in ends. Installed by `install-wekan-authwatch.sh`; tests in `trueog-wekan-authwatch-test.mjs`. |
| `upgrade/` | `/home/system/gitea-upgrade` | `upgrade-wekan.sh` (step-by-step upgrades with verified backups) and its helpers; `wekan-patch-13.06.py` applies TrueOG's patches to the compiled release. |

## Sign-in (since 2026-11-11)

- **Staff-Auth only.** Hydra client "TrueOG WeKan" (authorization code, scopes `openid profile email`,
  `client_secret_post`, access tokens 2160 h). `OAUTH2_*` in the environment; `OAUTH2_ID_MAP=sub`, so a WeKan
  account is linked to a Staff-Auth account by `services.oidc.id` = Staff-Auth's user uuid. Any active Staff-Auth
  account may sign in; the first sign-in creates the WeKan account (named after the Minecraft name).
- **No passwords.** `PASSWORD_LOGIN_ENABLED=false` hides the form; no account has a stored password, so the server
  refuses password logins too. Registration and "forgot password" are disabled in the Admin Panel.
- **Straight to Staff-Auth.** `OIDC_REDIRECTION_ENABLED=true`: a signed-out visit goes to Staff-Auth (one automatic
  try per browser tab). WeKan only redirects after its own sign-in page has drawn, so nginx injects a style that keeps
  that page (`.auth-layout`) invisible for 3 seconds; if the redirect did not happen, the button appears.
- **Real client addresses.** `HTTP_FORWARDED_COUNT=1`: nginx resolves the visitor from Cloudflare's
  `CF-Connecting-IP` and appends it as the last `X-Forwarded-For` entry; WeKan listens on 127.0.0.1 only.
- **Patches** (`upgrade/wekan-patch-13.06.py`, same changes as this fork's source): `setBoardTeams` (members of a
  board's teams become board members server-side) and `oidcSignup` (accounts created by the OIDC service need no
  invitation code although registration is disabled; `server/models/users.js`).
- **Ending a sign-in.** `trueog-wekan-authwatch` locks a WeKan account (disabled, sessions ended; open tabs closed
  within about 2 s through WeKan's own API) when its Staff-Auth account is deactivated or deleted, unlocks it when the
  account is active again, and signs a person out of WeKan (sessions ended, account not disabled) when Hydra no longer
  accepts the token from their last sign-in (logout, revocation, expiry). No account is exempt. Add each new WeKan
  version to `REVIEWED_WEKAN` after reading its source, or the service only watches.

## Admin Panel settings (stored in WeKan's database, not in files)

| Setting | Value |
| --- | --- |
| Disable registration / forgot password | on / on |
| Display authentication method | off |
| OIDC button text (`oidcBtnText`) | `Sign in with Staff-Auth` |
| Custom HTML after body start | `<style>/* TrueOG: hide the minicard completion checkbox */ .minicard-title .minicard-complete-toggle { display: none !important; }</style>` |

The WeKan account `staffauth-lockbot` (no password, marked `trueogLockBot`) is created by the authwatch installer;
it must stay an administrator and enabled for open tabs to close at once.
