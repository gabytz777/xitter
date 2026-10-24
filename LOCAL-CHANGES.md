# Local changes in this fork

This is a deployment fork of [Xitter](https://github.com/Xittered/xitter), running at
<https://social.opsex.best>. It is upstream `main` merged in, plus the changes below.

Nothing operational is in here: `.env`, the database and the media volume are not
part of the repository, and neither is the runbook the operators keep.

## What this fork adds

- **An assistant account** — `src/grok.ts`, `scripts/grok-setup.ts` and the `llm`
  service in `compose.yaml`. The account named by `GROK_HANDLE` answers posts that
  mention it, with a completion from a small local model (SmolLM2 135M) served by
  llama.cpp. Unset `GROK_HANDLE` and it is off entirely.
- **Pinned follows** — `src/users.ts` and `src/blocks.ts`. Accounts in the
  `pinned_follows` setting (Admin > Settings > Sign-up, seeded from
  `PINNED_FOLLOWS`) cannot be unfollowed or blocked, by anyone including staff.
- **A rickroll for unknown profiles** — `src/server.ts`, with the reserved names it
  has to skip in `src/invites.ts`. A profile URL for a handle nobody has redirects
  to a music video; `RICKROLL=0` turns that off. Maintenance mode also covers
  signed-out visitors.
- **Memory limits** — `compose.yaml` caps the app and the database at 2 GiB each
  with `oom_score_adj: -500`, and the model server at 1 CPU and 768 MB. The host is
  a dual-core Celeron with 3.7 GiB, so loose caps are deliberate: a tight cgroup
  limit kills the app mid-request.
- **Ops scripts** — `scripts/maintenance.ts` and `scripts/set-password.ts`.
- **Sign in with Discord** — `src/discord.ts`, `src/reset-tokens.ts`, the
  `discord_accounts` table in `src/schema.sql`, and the button `src/shell.ts`
  adds to X's own sign-in dialog. With `DISCORD_CLIENT_ID` and
  `DISCORD_CLIENT_SECRET` set, an account can be linked to a Discord account
  (`/account/discord`), a new Discord sign-in creates an account when sign-up is
  open, and a linked account can reset its password by proving itself to
  Discord — which is the only reset path here, since no mail is configured. The
  same reset link is DMed through the bot (`DISCORD_BOT_TOKEN`) when the
  forgot-password form is used. Where a screen asks for the password itself,
  "Confirm with Discord" (`src/step-up.ts`) proves the same thing without a
  message and comes straight back: fifteen minutes in which changing the email,
  adding a passkey or making a migration code needs no password. No password is
  ever sent anywhere.

Upstream's own tests are unmodified and run here before every deploy: `bun run
test:unit`, then the `scripts/test-*.ts` cases, as `.github/workflows/tests.yml`
describes.
