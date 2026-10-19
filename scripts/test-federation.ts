// usage: bun scripts/test-federation.ts

import { SQL } from "bun";
import { newId } from "../src/ids";
import { codeAt, newSecret } from "../src/totp";

const A = { origin: process.env.FED_A ?? "http://localhost:3041", db: new SQL(process.env.FED_A_DB ?? "postgres://tiago@127.0.0.1:5432/fed_a") };
const B = { origin: process.env.FED_B ?? "http://localhost:3042", db: new SQL(process.env.FED_B_DB ?? "postgres://tiago@127.0.0.1:5432/fed_b") };
const idOf = (origin: string) => new URL(origin).host;
const stamp = Date.now().toString(36).slice(-6);
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
async function until<T>(get: () => Promise<T>, seconds = 40): Promise<T | undefined> {
	for (let i = 0; i < seconds * 2; i++) {
		const v = await get().catch(() => undefined);
		if (v) return v;
		await Bun.sleep(500);
	}
	return undefined;
}

async function account(side: typeof A, name: string) {
	const id = newId();
	await side.db`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${name}, ${name}, ${await Bun.password.hash("testpass123")})`;
	const r = await fetch(`${side.origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "" };
	return {
		id,
		name,
		gql: async (op: string, variables: object) =>
			(await fetch(`${side.origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json(),
		get: async (op: string, variables: object) =>
			(await fetch(`${side.origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json(),
		form: (path: string, body: Record<string, string>) => fetch(`${side.origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) }),
		raw: (path: string) => fetch(`${side.origin}${path}`, { headers }),
	};
}

const made: { side: typeof A; id: string }[] = [];
try {
	const alice = await account(A, `fa${stamp}`);
	const bob = await account(B, `fb${stamp}`);
	made.push({ side: A, id: alice.id }, { side: B, id: bob.id });

	const posted = await alice.gql("CreateTweet", { tweet_text: `hello from a ${stamp}` });
	const postId = posted.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	check("alice posts on A", !!postId);

	const aliceOnB = await until(async () => (await B.db`select id::text from users where instance = ${idOf(A.origin)} and remote_id = ${alice.id}::bigint`)[0]?.id as string);
	check("B keeps a copy of alice", !!aliceOnB);
	const [handle] = aliceOnB ? await B.db`select screen_name from users where id = ${aliceOnB}::bigint` : [];
	check("named with her instance", handle?.screen_name === `${alice.name}@${idOf(A.origin)}`, handle?.screen_name);
	const preview = await fetch(`${B.origin}/${alice.name}@${idOf(A.origin)}`, { redirect: "manual" });
	check("B previews her for link fetchers by her full handle", preview.status === 200 && (await preview.text()).includes("og:title"), preview.status);
	const mirror = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${postId}::bigint`)[0]?.local_id as string);
	check("and her post", !!mirror);
	const syncStatus = await until(async () => {
		const doc = (await (await fetch(`${B.origin}/.well-known/xitter`)).json()) as any;
		return doc.federation?.peers?.find((p: any) => p.id === idOf(A.origin) && p.federating && p.last_sync_at);
	}, 60);
	check("B's public status shows when it last synced with A", !!syncStatus, syncStatus);

	const found = await bob.get("UserByScreenName", { screen_name: `${alice.name}@${idOf(A.origin)}`, withSafetyModeUserFields: true });
	check("bob finds alice by her handle", found.data?.user?.result?.rest_id === aliceOnB, found.data?.user?.result?.rest_id);

	await bob.form("/1.1/friendships/create.json", { user_id: aliceOnB ?? "" });
	const bobOnA = await until(async () => (await A.db`select id::text from users where instance = ${idOf(B.origin)} and remote_id = ${bob.id}::bigint`)[0]?.id as string);
	check("A learns about bob", !!bobOnA);
	check(
		"A sees bob follow alice",
		!!(await until(async () => (await A.db`select 1 from follows where follower_id = ${bobOnA ?? "0"}::bigint and followee_id = ${alice.id}::bigint`).length > 0)),
	);

	await bob.gql("FavoriteTweet", { tweet_id: mirror });
	check("A sees bob's like", !!(await until(async () => (await A.db`select 1 from likes where user_id = ${bobOnA ?? "0"}::bigint and post_id = ${postId}::bigint`).length > 0)));

	const reply = await bob.gql("CreateTweet", { tweet_text: `hi alice ${stamp}`, reply: { in_reply_to_tweet_id: mirror } });
	const replyId = reply.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	check("bob replies on B", !!replyId, reply.errors);
	const replyOnA = await until(async () => (await A.db`select local_id::text from federated_objects where instance = ${idOf(B.origin)} and kind = 'post' and remote_id = ${replyId}::bigint`)[0]?.local_id as string);
	const [threaded] = replyOnA ? await A.db`select reply_to_id::text, reply_to_user_id::text from posts where id = ${replyOnA}::bigint` : [];
	check("A threads bob's reply under alice's post", threaded?.reply_to_id === postId && threaded?.reply_to_user_id === alice.id, threaded);

	const mentionA = await alice.gql("CreateTweet", { tweet_text: `hey @${bob.name}@${idOf(B.origin)}, I'm @${alice.name} ${stamp}` });
	const mentionId = mentionA.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	const mentionsHere = await A.db`select user_id::text from post_mentions where post_id = ${mentionId ?? "0"}::bigint order by user_id`;
	check("a mention by full handle points at the copy, not a local namesake", mentionsHere.some((m: any) => m.user_id === bobOnA), mentionsHere);
	const entities = mentionA.data?.create_tweet?.tweet_results?.result?.legacy?.entities?.user_mentions ?? [];
	const fullEntity = entities.find((m: any) => m.id_str === bobOnA);
	check("and its entity covers the whole handle", fullEntity?.screen_name === `${bob.name}@${idOf(B.origin)}` && fullEntity.indices[1] - fullEntity.indices[0] === `@${bob.name}@${idOf(B.origin)}`.length, entities);
	const mentionOnB = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${mentionId ?? "0"}::bigint`)[0]?.local_id as string);
	const mentionsThere = mentionOnB ? (await B.db`select user_id::text from post_mentions where post_id = ${mentionOnB}::bigint`).map((m: any) => m.user_id) : [];
	check("on B it mentions bob himself and alice's copy", mentionsThere.includes(bob.id) && mentionsThere.includes(aliceOnB), mentionsThere);
	const bobNotified = await until(async () => {
		const n = await bob.get("NotificationsTimeline", { timeline_type: "Mentions", count: 20 });
		return JSON.stringify(n).includes(mentionOnB ?? "none");
	}, 10);
	check("and bob gets the mention", !!bobNotified);

	const mediaId = newId();
	const picture = Buffer.from(`GIF89a-${stamp}`);
	const picturePost = newId();
	await Bun.write(`${process.env.FED_A_MEDIA}/${mediaId}`, picture);
	await A.db.begin(async (tx) => {
		await tx`insert into posts (id, user_id, text, conversation_id) values (${picturePost}::bigint, ${alice.id}::bigint, 'a picture', ${picturePost}::bigint)`;
		await tx`insert into media (id, user_id, kind, mime, size, width, height, post_id, position) values (${mediaId}::bigint, ${alice.id}::bigint, 'photo', 'image/gif', ${picture.length}, 1, 1, ${picturePost}::bigint, 0)`;
		await tx`update posts set text = 'a picture!' where id = ${picturePost}::bigint`;
	});
	const pictureOnB = await until(async () => (await B.db`select m.id::text from media m join federated_objects f on f.kind = 'post' and f.local_id = m.post_id where f.remote_id = ${picturePost}::bigint`)[0]?.id as string);
	check("B lists the picture", !!pictureOnB);
	const served = pictureOnB ? await bob.raw(`/media/${pictureOnB}.gif`) : undefined;
	check("and serves it from its own address", served?.status === 200 && Buffer.from(await served.arrayBuffer()).equals(picture), served?.status);

	await alice.gql("DeleteTweet", { tweet_id: postId });
	check("a deleted post goes from B", !!(await until(async () => !(await B.db`select 1 from posts where id = ${mirror ?? "0"}::bigint`).length)));

	await A.db`update users set protected = true where id = ${alice.id}::bigint`;
	check("a protected account's posts go from B", !!(await until(async () => !(await B.db`select 1 from posts where user_id = ${aliceOnB ?? "0"}::bigint`).length)));

	const carol = await account(A, `fc${stamp}`);
	made.push({ side: A, id: carol.id });
	const carolOnB = await until(async () => (await B.db`select id::text from users where screen_name = ${`${carol.name}@${idOf(A.origin)}`}`)[0]?.id as string | undefined);
	await A.db`update users set status = 'suspended' where id = ${carol.id}::bigint`;
	check("a suspended account goes from B", !!carolOnB && !!(await until(async () => !(await B.db`select 1 from users where id = ${carolOnB ?? "0"}::bigint`).length)));
	await A.db`update users set status = 'active' where id = ${carol.id}::bigint`;
	const carolBack = await until(async () => (await B.db`select id::text from users where screen_name = ${`${carol.name}@${idOf(A.origin)}`}`)[0]?.id as string | undefined);
	check("and comes back when it's lifted", !!carolBack, carolBack);
	await A.db`delete from users where id = ${carol.id}::bigint`;
	check("a deleted account goes from B", !!(await until(async () => !(await B.db`select 1 from users where screen_name = ${`${carol.name}@${idOf(A.origin)}`}`).length)));

	const forged = await fetch(`${A.origin}/federation/v1/events?after=0`, {
		headers: { "x-xitter-from": idOf(B.origin), "x-xitter-to": idOf(A.origin), "x-xitter-timestamp": String(Date.now()), "x-xitter-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-xitter-signature": "x".repeat(86) },
	});
	check("an unsigned request is refused", forged.status === 401, forged.status);
	const stranger = await fetch(`${A.origin}/federation/v1/events?after=0`, {
		headers: { "x-xitter-from": "evil.example", "x-xitter-to": idOf(A.origin), "x-xitter-timestamp": String(Date.now()), "x-xitter-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-xitter-signature": "x".repeat(86) },
	});
	check("an instance off the list is refused", stranger.status === 403, stranger.status);
	const login = await fetch(`${A.origin}/login`, { method: "POST", body: new URLSearchParams({ username: `${bob.name}@${idOf(B.origin)}`, password: "!" }), redirect: "manual" });
	check("nobody signs in as a copied account", !login.headers.getSetCookie().some((c) => c.startsWith("auth_token=")));

	const admin = await account(A, `fadm${stamp}`);
	made.push({ side: A, id: admin.id });
	await A.db`update users set role = 'admin' where id = ${admin.id}::bigint`;
	const adminApi = async (side: typeof A, cookies: string, action: string, body: object) => {
		const csrf = /ct0=([^;]+)/.exec(cookies)?.[1] ?? "";
		const r = await fetch(`${side.origin}/admin/api/${action}`, { method: "POST", headers: { cookie: cookies, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, body: await r.json().catch(() => ({})) };
	};
	const [adminSession] = await A.db`select token, csrf from sessions where user_id = ${admin.id}::bigint`;
	const adminCookies = `auth_token=${adminSession.token}; ct0=${adminSession.csrf}`;
	const status = await adminApi(A, adminCookies, "federation", {});
	check("the admin panel shows federation", status.status === 200 && status.body.id === idOf(A.origin) && status.body.instances.some((i: any) => i.id === idOf(B.origin) && i.federating), status.body.error);
	const blocked = await adminApi(A, adminCookies, "federationBlock", { instance: idOf(B.origin), reason: "test" });
	check("an admin defederates B", blocked.status === 200, blocked.body);
	check("B's accounts drop out of view on A", (await A.db`select instance_blocked from users where id = ${bobOnA ?? "0"}::bigint`)[0]?.instance_blocked === true);
	const hiddenPreview = await fetch(`${A.origin}/${bob.name}@${idOf(B.origin)}`, { redirect: "manual" });
	check("and out of A's link previews", hiddenPreview.status === 302, hiddenPreview.status);
	await bob.gql("CreateTweet", { tweet_text: `after the block ${stamp}` });
	await Bun.sleep(20_000);
	check("nothing new arrives from B", !(await A.db`select 1 from posts where user_id = ${bobOnA ?? "0"}::bigint and text like 'after the block%'`).length);
	await adminApi(A, adminCookies, "federationUnblock", { instance: idOf(B.origin) });
	check("lifting it catches up", !!(await until(async () => (await A.db`select 1 from posts where user_id = ${bobOnA ?? "0"}::bigint and text like 'after the block%'`).length > 0)));

	const editCopy = await adminApi(A, adminCookies, "updateUser", { id: bobOnA, name: "renamed here" });
	check("admins can't edit a copy of another instance's account", editCopy.status === 403 && /lives on/.test(editCopy.body.error ?? ""), editCopy.body);
	const roleCopy = await adminApi(A, adminCookies, "setRole", { id: bobOnA, role: "admin" });
	check("or make it staff", roleCopy.status === 403, roleCopy.body);
	const suspendCopy = await adminApi(A, adminCookies, "setStatus", { id: bobOnA, status: "suspended" });
	check("but they can suspend it here", suspendCopy.status === 200, suspendCopy.body);
	await adminApi(A, adminCookies, "setStatus", { id: bobOnA, status: "active" });

	const meowId = newId();
	const secret = newSecret();
	const existing = await A.db`select id::text from users where lower(screen_name) = 'meow'`;
	if (existing.length) await A.db`delete from users where lower(screen_name) = 'meow'`;
	await A.db`insert into users (id, screen_name, name, password_hash, role, totp_enabled, totp_secret) values (${meowId}::bigint, 'meow', 'meow', ${await Bun.password.hash("testpass123")}, 'admin', true, ${secret})`;
	made.push({ side: A, id: meowId });
	const meowToken = newId();
	await A.db`insert into sessions (token, user_id, csrf) values (${meowToken}, ${meowId}::bigint, 'meowcsrf')`;
	const meowCookies = `auth_token=${meowToken}; ct0=meowcsrf`;
	const ask = (path: string, form: Record<string, string>) => fetch(`${A.origin}${path}`, { method: "POST", headers: { cookie: meowCookies }, body: new URLSearchParams(form), redirect: "manual" });
	const page = await (await ask("/federation/superadmin/enter", { instance: idOf(B.origin), password: "testpass123", code: codeAt(secret, Math.floor(Date.now() / 30000)) })).text();
	const ticket = /name="ticket" value="([^"]+)"/.exec(page)?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
	check("meow gets a ticket after password and code", !!ticket, page.slice(0, 200));
	const replay = await (await ask("/federation/superadmin/enter", { instance: idOf(B.origin), password: "testpass123", code: codeAt(secret, Math.floor(Date.now() / 30000)) })).text();
	check("the same code can't be used twice", !replay.includes('name="ticket"'));
	const wrong = await (await ask("/federation/superadmin/enter", { instance: idOf(B.origin), password: "wrong", code: "000000" })).text();
	check("a wrong password gets no ticket", !wrong.includes('name="ticket"'));
	const notMeow = await fetch(`${A.origin}/federation/superadmin`, { headers: { cookie: adminCookies } });
	check("other admins don't see the superadmin page", notMeow.status === 404);
	const entered = await fetch(`${B.origin}/federation/superadmin/accept`, { method: "POST", body: new URLSearchParams({ ticket: ticket ?? "" }), redirect: "manual" });
	const superCookies = entered.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	check("B lets meow in with it", entered.status === 303 && superCookies.includes("auth_token="), entered.status);
	const asSuper = await adminApi(B, superCookies, "federation", {});
	check("with an admin session there", asSuper.status === 200, asSuper.body);
	const again = await fetch(`${B.origin}/federation/superadmin/accept`, { method: "POST", body: new URLSearchParams({ ticket: ticket ?? "" }), redirect: "manual" });
	check("the ticket works once", again.status === 403, again.status);
	const tampered = ticket ? JSON.stringify({ ...JSON.parse(ticket), key_id: idOf(B.origin) }) : "";
	const forgedTicket = await fetch(`${B.origin}/federation/superadmin/accept`, { method: "POST", body: new URLSearchParams({ ticket: tampered }), redirect: "manual" });
	check("a ticket from anywhere else is refused", forgedTicket.status === 403, forgedTicket.status);
	const [superOnB] = await B.db`select u.id::text from users u where u.instance = ${idOf(A.origin)} and u.screen_name = ${`meow@${idOf(A.origin)}`}`;
	const bAdmin = await account(B, `fbadm${stamp}`);
	made.push({ side: B, id: bAdmin.id });
	await B.db`update users set role = 'admin' where id = ${bAdmin.id}::bigint`;
	const [bSession] = await B.db`select token, csrf from sessions where user_id = ${bAdmin.id}::bigint`;
	const demote = await adminApi(B, `auth_token=${bSession.token}; ct0=${bSession.csrf}`, "setStatus", { id: superOnB?.id, status: "suspended" });
	check("B's own admins can't act on the superadmin", demote.status === 403, demote.body);

	const sent = await (await ask("/federation/superadmin/emergency", { instance: "localhost:3043", action: "block", reason: "test emergency", password: "testpass123", code: codeAt(secret, Math.floor(Date.now() / 30000) + 1) })).text();
	check("meow sends an emergency defederation", sent.includes("Sent."), sent.slice(0, 300));
	check("B applies it", !!(await until(async () => (await B.db`select source from federation_blocks where instance = 'localhost:3043'`)[0]?.source === "emergency", 30)));
	const lifted = await adminApi(B, superCookies, "federationUnblock", { instance: "localhost:3043" });
	check("a superadmin session can lift it locally", lifted.status === 200, lifted.body);

	const rename = await fetch(`${A.origin}/1.1/account/settings.json`, { method: "POST", headers: { cookie: meowCookies, "x-csrf-token": "meowcsrf" }, body: new URLSearchParams({ screen_name: `meow${stamp}` }) });
	check("meow can't rename away from the superadmin handle", rename.status === 400, await rename.text());
	const org = await adminApi(A, adminCookies, "createOrg", { screen_name: "MEOW", name: "meow" });
	check("nobody makes an org with that handle", org.status !== 200 && /reserved/.test(org.body.error ?? ""), org.body);

	const blockAdmin = await alice.form("/1.1/blocks/create.json", { user_id: admin.id });
	check("alice can't block an admin of her own instance", blockAdmin.status === 403, blockAdmin.status);
	await A.db`insert into blocks (blocker_id, blocked_id) values (${alice.id}::bigint, ${admin.id}::bigint) on conflict do nothing`;
	check("not even by writing the row", !(await A.db`select 1 from blocks where blocker_id = ${alice.id}::bigint and blocked_id = ${admin.id}::bigint`).length);
	const later = await account(A, `fl${stamp}`);
	made.push({ side: A, id: later.id });
	const blockLater = await alice.form("/1.1/blocks/create.json", { user_id: later.id });
	check("alice blocks someone who isn't staff", blockLater.status === 200, blockLater.status);
	await A.db`update users set role = 'admin' where id = ${later.id}::bigint`;
	check("and the block goes when they become an admin", !(await A.db`select 1 from blocks where blocker_id = ${alice.id}::bigint and blocked_id = ${later.id}::bigint`).length);
	const blockSuper = await bob.form("/1.1/blocks/create.json", { user_id: superOnB?.id ?? "0" });
	check("bob can't block a superadmin, who admins B too", blockSuper.status === 403, blockSuper.status);
	const adminOnB = await until(async () => (await B.db`select id::text from users where instance = ${idOf(A.origin)} and remote_id = ${admin.id}::bigint`)[0]?.id);
	const blockRemoteAdmin = await bob.form("/1.1/blocks/create.json", { user_id: adminOnB ?? "0" });
	check("bob can block A's admin, whose instance isn't his", blockRemoteAdmin.status === 200, { status: blockRemoteAdmin.status, adminOnB });

	const bCookies = `auth_token=${bSession.token}; ct0=${bSession.csrf}`;
	const acceptHome = await adminApi(B, bCookies, "federationAcceptKey", { instance: idOf(A.origin) });
	check("B's admins can't accept a new key for the superadmin's home", acceptHome.status === 403, acceptHome.body);
	const [pinnedOnB] = await B.db`select key from federation_peers where instance = ${idOf(A.origin)}`;
	if (process.env.FED_REGISTRY && process.env.FED_B_KEY_FILE) {
		const forgedList = `${process.env.FED_REGISTRY}.forged.json`;
		const list = JSON.parse(await Bun.file(process.env.FED_REGISTRY).text());
		list.sequence += 1;
		for (const i of list.instances) if (i.id === idOf(A.origin)) i.public_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		await Bun.write(forgedList, JSON.stringify(list));
		const probe = () => {
			const run = Bun.spawnSync(["bun", "-e", `import { refreshRegistry, keyFor, pendingKeyChange } from "./src/federation"; await refreshRegistry(); console.log(JSON.stringify({ key: await keyFor(${JSON.stringify(idOf(A.origin))}), pending: await pendingKeyChange(${JSON.stringify(idOf(A.origin))}) })); process.exit(0);`], {
				env: { ...process.env, DATABASE_URL: process.env.FED_B_DB ?? "postgres://tiago@127.0.0.1:5432/fed_b", PUBLIC_ORIGIN: B.origin, FEDERATION_REGISTRY_URL: forgedList, FEDERATION_KEY_FILE: process.env.FED_B_KEY_FILE, FEDERATION_ALLOW_HTTP: "1", XITTER_TEST_SUPERADMINS: `meow@${idOf(A.origin)}` },
			});
			return { stdout: run.stdout, stderr: run.stderr };
		};
		const firstProbe = probe();
		await B.db`update federation_peers set key = null where instance = ${idOf(A.origin)}`;
		const fresh = JSON.parse(probe().stdout.toString().trim().split("\n").pop() || "{}");
		const [afterFresh] = await B.db`select key from federation_peers where instance = ${idOf(A.origin)}`;
		await B.db`update federation_peers set key = ${pinnedOnB?.key ?? null} where instance = ${idOf(A.origin)}`;
		await B.db`delete from federation_state where key = 'registry'`;
		check("on first contact, a home key the list and the home disagree on is refused", !fresh.key && !afterFresh?.key, { fresh, stored: afterFresh?.key });
		const seen = JSON.parse(firstProbe.stdout.toString().trim().split("\n").pop() || "{}");
		check("a list that swaps the home's key doesn't replace the pinned one", !!pinnedOnB?.key && seen.key === pinnedOnB.key, { seen, pinned: pinnedOnB?.key, err: firstProbe.stderr.toString().slice(0, 300) });
		check("and shows up as a key change", seen.pending === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", seen);
	}

	if (process.env.FED_D_DB) {
		const D = new SQL(process.env.FED_D_DB);
		const paused = await until(async () => (await D`select last_error from federation_peers where instance = ${idOf(A.origin)}`)[0]?.last_error ?? "", 60);
		check("an instance over its hourly budget is paused", /paused/.test(paused ?? ""), paused);
		const [{ cursor }] = await D`select cursor::text from federation_peers where instance = ${idOf(A.origin)}`;
		const [{ head }] = await A.db`select max(seq)::text as head from federation_outbox`;
		check("and it stops reading before the end, after the events it applied", BigInt(cursor) > 0n && BigInt(cursor) < BigInt(head), { cursor, head });
	}
} finally {
	for (const m of made) await m.side.db`delete from users where id = ${m.id}::bigint`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
