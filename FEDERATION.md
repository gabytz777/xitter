# Federation

Xitter instances on a shared list exchange public accounts, posts, media,
likes, reposts and follows. Each instance moderates its own people. Any
instance can stop federating with another one at any time, and a few
hardcoded superadmins can act on every instance in an emergency.

The design follows meowcord's federation: a list of instances kept in Git and
changed by pull request, an Ed25519 key per instance, and signed requests
between instances.

## The list

`instances.json` at the root of this repository is the list. Every instance
fetches it from the `main` branch every 5 minutes and falls back to the copy
bundled in its image when GitHub can't be reached.

```json
{
	"id": "xit.example.org",
	"name": "Example",
	"source_url": "https://github.com/example/xitter",
	"public_key": "the 43-character key from https://xit.example.org/.well-known/xitter",
	"state": "active"
}
```

- `id` is the instance's host name, without a scheme, port or path.
- `public_key` can be `null`. Peers then pin the key the instance serves the
  first time they talk to it, and only an admin can accept a different key
  later.
- `state` is `active`, `suspended` or `blocked`. A suspended or blocked
  instance is defederated by every instance that reads the list.
- `sequence` at the top must go up with every change. An instance refuses a
  list whose sequence is lower than the last one it saw, so an old copy can't
  be replayed to bring back a blocked instance.

### Adding an instance

1. Deploy Xitter on its final domain with HTTPS.
2. Open the admin panel, then Federation. It shows the entry for this
   instance, key included.
3. Open a pull request that adds the entry to `instances.json`, keeps the list
   sorted by `id` and raises `sequence` by one. Run
   `bun scripts/check-instances.ts --write-md` to update `INSTANCES.md`, the
   readable copy of the list.

The `instances` workflow runs `scripts/check-instances.ts` on the pull
request. It checks the format, refuses a sequence that doesn't go up, and
fetches `/.well-known/xitter` from every added or changed instance to confirm
it is reachable and serves the listed key. Run it locally with:

```bash
git show origin/main:instances.json > /tmp/base.json
```

```bash
bun scripts/check-instances.ts --base /tmp/base.json --online
```

The workflow runs the checker from the pull request's own branch, so a
reviewer must also read any change to `scripts/check-instances.ts` or the
workflow. A key change for an instance that is already listed is printed as a
note: confirm it with that instance's admins somewhere other than the pull
request before merging.

## What is shared

Only public things travel. A protected account, a post in a community, an
article and a hidden post stay on their instance. When an account is
protected, deleted or suspended, or a post is deleted, the copies on other
instances go too.

Accounts from another instance show up as `name@instance`. Nobody can sign in
to one of those copies. Media is fetched from its home instance the first time
someone asks for it and served from the local address after that.

## Protocol

Every instance has an Ed25519 key in `data/federation-key.json` (or
`FEDERATION_KEY_FILE`), created on first start. Keep it with the rest of
`data/`. Losing it means asking every peer to accept a new key.

`GET /.well-known/xitter` returns the instance's address, software, protocol
and public key. Under `federation.peers` it lists every other instance on the
list, whether it federates with it and when it last pulled from it
successfully, so anyone can see that two instances are syncing.

Requests between instances carry these headers:

| Header | Content |
| --- | --- |
| `x-xitter-from` | the sender's id |
| `x-xitter-to` | the receiver's id |
| `x-xitter-timestamp` | Unix seconds, at most 5 minutes off |
| `x-xitter-nonce` | 22 random characters, used once |
| `x-xitter-signature` | Ed25519 signature over the lines below |

```
xitter-federation-v1
request
<method>
<path and query>
<from>
<to>
<timestamp>
<nonce>
<sha256 of the body, hex>
```

The receiver refuses a request from an instance that isn't on the list or is
defederated, a wrong signature, an old timestamp, a repeated nonce and a body
over 4 MB. Answers are signed with the same scheme and bound to the request's
nonce, so a peer can't be fed a replayed answer.

Changes travel by pulling. Database triggers write every change to a local,
public account into an outbox. Peers read it with
`GET /federation/v1/events?after=<cursor>` every 15 seconds, and
`POST /federation/v1/poke` makes a peer pull right away. Events name an object
and are rendered when they are read, so reading one twice is harmless and a
deleted object is never sent.

Other endpoints, all signed:

- `GET /federation/v1/objects/user/<id>` and `/objects/post/<id>`
- `GET /federation/v1/users/by-name/<screen_name>`
- `GET /federation/v1/media/<id>` and `/media/<id>/poster`

## Moderation

Each instance moderates its own accounts, and what an instance removes is
removed everywhere. Admins of every instance can also act on the copies they
hold, the same way as on local accounts.

In the admin panel, under Federation, an admin can:

- **Defederate** an instance. Nothing is sent to it or accepted from it, and
  its accounts and posts disappear from view. Federating again catches up from
  where it stopped.
- **Delete its content** once it is defederated. This removes every copied
  account, post and file that came from it.
- **Accept the new key** of an instance whose key changed.
- **Sync now** to pull from an instance right away.

A list block (state `suspended` or `blocked`) can only be lifted by changing
the list. An emergency block can only be lifted by a superadmin.

## Superadmins

Superadmins are hardcoded in `src/superadmins.ts`:

| Account | Home instance |
| --- | --- |
| `meow` | `xitter.opuadm.com` |
| `pozo` | `xit.chococat.lol` |
| `tiago` | `xit.chococat.lol` |

Changing them needs a commit to this repository and a new deploy of every
instance, so no admin panel, database row or list entry can add one.

A superadmin acts on another instance with a ticket from their home instance:

1. They open `/federation/superadmin` on their home instance. The page only
   exists for the hardcoded account, which must be an admin with two-factor
   authentication turned on.
2. They enter their password and a fresh two-factor code. A code works once,
   and attempts are rate limited.
3. The home instance signs a ticket for one target instance. It is valid for
   60 seconds and carries a random nonce.
4. The browser posts the ticket to `/federation/superadmin/accept` on the
   target. The target checks that it was signed by the home instance's key,
   is addressed to it, hasn't expired, names a hardcoded superadmin and was
   issued after a password and two-factor check, and that its nonce was never
   used.
5. The target signs them in as an admin for 60 minutes and writes the entry to
   its audit log.

On every instance:

- local admins can't suspend, demote or otherwise act on a superadmin's
  account;
- a superadmin's username can't change on their home instance, and nobody
  else can sign up, rename to it or create an organization with it, even if
  the account is deleted.

Because of that, a superadmin account that doesn't exist yet can't be made
through the sign-up page. Create it on the server with
`bun scripts/create-user.ts <name> <password>` and `bun scripts/make-admin.ts <name> admin`,
then turn on two-factor authentication from its settings.

### Emergency defederation

From the same page, a superadmin can defederate an instance everywhere. Their
home instance signs an emergency notice, pushes it to every listed instance
and serves all its notices at `GET /federation/v1/emergencies`, which every
instance also reads every 60 seconds. An instance applies a notice only when
the signature matches the superadmin's home key. A later notice from a
superadmin can lift it.

### Superadmin home keys

Every instance looks up a superadmin's home key in this order:

1. `instance_key` in `src/superadmins.ts`, when it is set;
2. the key it pinned the first time it talked to that home, which happens at
   start-up and every 10 minutes;
3. for that first contact, the key the home serves at `/.well-known/xitter`.
   When `instances.json` lists a key for the home too, both must match, or
   nothing is pinned and tickets and emergency notices from that home are
   refused.

After the first contact, a list change can't replace the home's key. A
different key shows up as a key change in the admin panel, and only a
superadmin can accept it.

The keys of `xitter.opuadm.com` and `xit.chococat.lol` are pinned in
`instances.json` and as `instance_key` in `src/superadmins.ts`, so no list
change or first contact decides them. Each superadmin's account id is pinned
as `user_id` too, so a new account that takes the same name on a home
instance is never a superadmin. If one of them loses
`data/federation-key.json`, its superadmins can't issue tickets until the new
key is pinned here and every instance redeploys, so back that file up. A new
superadmin home gets the same
treatment once it runs with federation:

1. Put the instance's key from `/.well-known/xitter` in its `public_key` in
   `instances.json`.
2. In `src/superadmins.ts`, set `instance_key` to the same key, and `user_id`
   to the superadmin's account id on their home instance. A pinned id stops a
   different account with the same name from being accepted.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FEDERATION` | on | `off` turns federation off |
| `FEDERATION_KEY_FILE` | `data/federation-key.json` | The instance's private key |
| `FEDERATION_REGISTRY_URL` | `instances.json` on `main` | Where the list is read from (an absolute path works for testing) |
| `FEDERATION_EVENTS_PER_HOUR` | `20000` | Changes applied from one instance per hour. Past it, syncing with that instance pauses until the hour is over |
| `FEDERATION_MAX_ACCOUNTS` | `100000` | Accounts kept from one instance. New ones past it are refused |
| `FEDERATION_ALLOW_HTTP` | unset | Lets instances talk over plain HTTP, for the local test setup only |

`scripts/test-federation.ts` runs two instances against each other and checks
sync, defederation, superadmin tickets and emergency blocks.
