# Contributing

Thanks for helping. Xitter is a backend for X's own web client: most changes
mean finding what the client asks for and answering it in X's shapes.
[AGENTS.md](AGENTS.md) explains how the code fits together and the traps in
it; read it before your first change. Security problems go through
[SECURITY.md](SECURITY.md), not issues or pull requests.

## Before you start

- Bugs and ideas go in [issues](https://github.com/Xittered/xitter/issues).
  For anything bigger than a fix, open one first so we can agree on it.
- To add your instance to the federation list, follow
  [FEDERATION.md](FEDERATION.md#join-the-list) instead.

## Set up

Follow [Running it locally](README.md#running-it-locally) in the README:
Bun 1.4, PostgreSQL 14 or newer, `bun scripts/fetch-client.ts` for the
client, and ffmpeg if you touch video or media. On Windows use Git Bash.

Keep the client bundle, browser captures and your `.env` out of commits;
AGENTS.md lists everything that must never be committed.

## Making a change

- One topic per pull request. Fixes that touch the same file can share one;
  unrelated clean-ups can't.
- Match the code around you: tabs, double quotes, sparse comments that say
  why rather than what. Don't reformat lines you didn't change; it hides the
  real diff.
- Schema changes go in `src/schema.sql` as statements that can run again on
  an existing database (`if not exists`). Every instance migrates on start.
- New environment variables go in the README's Configuration table, new
  features in its "What works" list.
- Don't hard-code private API keys, accounts or someone else's domain. Read
  them from the environment, and switch the feature off without them. A
  public client key that an official app or site already ships (like the GIF
  providers' defaults in `src/gifs.ts`) may be the default, as long as the
  environment can override it.
- User-facing text follows X's wording where X has a screen for it, and plain
  English where it doesn't.

## Tests

Add or update a test for what you change. There are three kinds:

1. **Unit tests**, scripts that import `bun:test`. No server or database:

   ```sh
   bun run test:unit
   ```

2. **Database and HTTP suites**, listed in `.github/workflows/tests.yml`. They
   need an empty PostgreSQL database whose name contains `test` (the scripts
   refuse any other) and, for the HTTP ones, a running server.
   `scripts/ci-local.sh` runs the same list the CI does:

   ```sh
   createdb xitter_test
   DATABASE_URL=postgres://<user>@localhost:5432/xitter_test sh scripts/ci-local.sh
   ```

   It migrates the database, runs everything, starts and stops its own server
   on port 3137, and prints a summary. Use a database you can throw away. On
   Windows, `test-public-api-chunked-media` fails on its own (the connection
   resets differently there); everything else should pass.

3. **Feature scripts** in `scripts/test-*.ts` that run against a server you
   started yourself; each one's first lines give its arguments.

A passing script is not a working screen. For UI changes, check the real
client, either by hand or with `bun scripts/drive.ts <path> <steps...>`
(headless Edge, takes screenshots), and say in the pull request what you
checked.

CI runs on every pull request; a maintainer approves the first run from a
fork.

## Pull requests

- Say what changed, why, and how you tested it. Screenshots help for UI.
- Commit messages: a short subject line, then a body with what and why.
- Keep "Allow edits by maintainers" on: small fixes are often pushed straight
  to your branch so it can merge sooner.
- Pull requests are merged with a merge commit. If `main` moved on, merge it
  into your branch rather than rebasing a branch others may have pulled.

## License

Xitter is [AGPL-3.0](LICENSE). By contributing you agree your work is
released under it.
