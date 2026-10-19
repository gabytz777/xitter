# Federation

Xitter instances on a shared list see each other's public accounts and posts,
and people on one can follow, like, repost and reply to people on the others.
The list is [instances.json](instances.json), and you join it with a pull
request. [INSTANCES.md](INSTANCES.md) has the same list in a readable form.

## Make an instance

1. Get a server and a domain name that serves HTTPS.
2. Set Xitter up on it with the steps in the [README](README.md#running-it-locally),
   with `PUBLIC_ORIGIN` set to your address, for example
   `https://xit.example.org`. Federation is on by default.
3. Back up the `data/` folder. It holds your instance's federation key, and
   other instances stop trusting you if you lose it.

## Requirements

- A recent Xitter version with federation on, over HTTPS, with nothing behind a
  paywall.
- Active moderation, and a way for the project's moderators to reach you. Put
  your Discord username in your pull request.
- Public rules, written in the admin panel under Settings and shown at
  `/rules`, that ban:
  - sexual content of any kind, including pornography and non-consensual
    intimate media such as sharing or threatening to share private sexual
    images, AI-generated or deepfake ones included.
  - gore, including graphic images or videos of death, mutilation, serious
    injury or cruelty to people or animals.
  - harassment, doxxing, threats, incitement to violence, glorifying violent
    attacks and promoting terrorist or violent extremist groups.
  - attacking or demeaning people for their race, ethnicity, nationality,
    religion, sex, gender identity, sexual orientation, disability or age,
    including slurs, misgendering and deadnaming.
  - encouraging or instructing suicide, self-harm or eating disorders.
    Supportive and recovery discussion is allowed.
  - spam, scams and manipulation, such as unsolicited advertising, repetitive
    posting, bot activity, fake engagement, vote or metric manipulation,
    phishing, fake giveaways, pyramid schemes and deceptive financial offers.
  - misleading impersonation of a person, brand or organization.
  - anything illegal under Portuguese law or applicable EU law.
  - ban evasion, including new accounts made to get around a ban, a suspension
    or these rules.

An instance that doesn't enforce these rules can be suspended or blocked on the
list for a time or for good. The list's maintainers can refuse any pull request
and remove any instance.

## Join the list

1. Sign in as an admin and open the admin panel, then Federation. It shows the
   entry for your instance.
2. Fork this repository and add that entry to `instances.json`. Keep the list
   sorted by `id`, and raise `sequence` at the top by one.
3. Run this to update `INSTANCES.md`:

   ```bash
   bun scripts/check-instances.ts --write-md
   ```

4. Open a pull request with your Discord username in it. A check confirms your
   instance is online, serves the key you listed and has rules at `/rules`.

Once it is merged, every instance picks up the new list within 5 minutes and
starts syncing with yours. The Federation page shows when each instance last
synced.

## Moderating

Each instance moderates its own people, and what you remove from your instance
is removed everywhere. You can also suspend accounts from other instances on
yours.

From the Federation page you can defederate any instance. Its accounts and
posts disappear from yours and nothing more comes from it until you federate
again. You can also delete everything you got from it.

A few people listed in `src/superadmins.ts` can act on every instance in an
emergency, including defederating a bad instance everywhere at once.

## Leaving

Set `FEDERATION=off` to stop federating, and open a pull request that removes
your entry from `instances.json`.
