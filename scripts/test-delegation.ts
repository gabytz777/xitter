// Delegation (X's Delegate) and the automated account label, against a running
// server: invites and the invitee's setting, accepting, acting as the account
// with x-act-as-user-id, what a delegate may not do, Admin and Contributor
// rules, leaving; then Settings > Automation. Puts the accounts back afterwards.
// usage: bun scripts/test-delegation.ts <owner> <member> <other> <password>
import { sql } from "../src/db";

const [ownerName = "goldcorp", memberName = "tester1", otherName = "tester2", password = "testpass123"] = process.argv.slice(2);
const origin = `http://localhost:${process.env.PORT ?? 3000}`;
let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined || ok ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failed++;
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const base = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const id = (await sql`select id::text from users where lower(screen_name) = lower(${username})`)[0].id as string;
	const headers = (actAs?: string): Record<string, string> => ({ ...base, "content-type": "application/json", ...(actAs ? { "x-act-as-user-id": actAs, "x-contributor-version": "1" } : {}) });
	return {
		id,
		csrf,
		cookie: base.cookie,
		gql: async (op: string, vars: any = {}, actAs?: string) => {
			const res = await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: headers(actAs), body: JSON.stringify({ variables: vars }) });
			return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
		},
		get: async (op: string, vars: any = {}, actAs?: string) => {
			const res = await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(vars))}`, { headers: headers(actAs) });
			return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
		},
		rest: async (method: string, path: string, actAs?: string, body?: string) => {
			const h = headers(actAs);
			if (body) h["content-type"] = "application/x-www-form-urlencoded";
			const res = await fetch(`${origin}/i/api${path}`, { method, headers: h, body });
			return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
		},
	};
}

const owner = await session(ownerName);
const member = await session(memberName);
const other = await session(otherName);
const saved = await sql`select id::text, delegation_invites, automated_by::text from users where id = any(${sql.array([owner.id, member.id, other.id], "BIGINT")})`;
const clear = () => sql`delete from delegation_members where owner_id = any(${sql.array([owner.id, member.id, other.id], "BIGINT")})`;
await clear();
const made: string[] = [];

try {
	// ---- invites and the invitee's setting
	await member.gql("useDelegateMutation_settings_Mutation", { userId: member.id, invitationSetting: "Nobody" });
	let r = await owner.gql("useAddMemberModalMutation_add_Mutation", { userId: member.id, delegationGroupId: owner.id, selectedRole: "Contributor" });
	check(r.body.errors?.length, "an account that allows nobody can't be invited", r.body);
	await member.gql("useDelegateMutation_settings_Mutation", { userId: member.id, invitationSetting: "OnlyFollowing" });
	const follows = (await sql`select 1 from follows where follower_id = ${member.id}::bigint and followee_id = ${owner.id}::bigint`).length > 0;
	if (!follows) {
		r = await owner.gql("useAddMemberModalMutation_add_Mutation", { userId: member.id, delegationGroupId: owner.id, selectedRole: "Contributor" });
		check(r.body.errors?.length, "only-following refuses an account it doesn't follow", r.body);
	}
	await member.gql("useDelegateMutation_settings_Mutation", { userId: member.id, invitationSetting: "Everyone" });
	r = await member.get("DelegateQuery");
	check(r.body.data?.viewer_v2?.user_results?.result?.delegation_invitation_preferences === "Everyone", "the setting reads back", r.body);
	r = await owner.gql("useAddMemberModalMutation_add_Mutation", { userId: member.id, delegationGroupId: owner.id, selectedRole: "Contributor" });
	const invited = r.body.data?.delegation_group_invite_member?.members?.find((m: any) => m.user_results?.result?.rest_id === member.id);
	check(invited?.status === "Pending" && invited.role === "Contributor", "an invite starts pending", r.body);
	r = await owner.gql("useAddMemberModalMutation_add_Mutation", { userId: member.id, delegationGroupId: member.id, selectedRole: "Contributor" });
	check(r.body.errors?.length, "nobody can invite into another account's group", r.body);

	// ---- pending: no acting yet
	r = await member.get("Viewer", {}, owner.id);
	check(r.status === 403, "a pending member can't act as the account", r.status);
	r = await member.get("GroupsDelegateQuery");
	const pending = r.body.data?.viewer_v2?.pendingGroups?.[0];
	check(pending?.rest_id === owner.id && pending.handle_results?.result?.rest_id === owner.id, "the member sees the invite", r.body);
	const membershipId = pending?.members?.find((m: any) => m.user_results?.result?.rest_id === member.id)?.rest_id;
	r = await other.gql("InviteMenu_accept_Mutation", { membershipId });
	check(r.body.errors?.length, "someone else can't accept it", r.body);
	r = await member.gql("InviteMenu_accept_Mutation", { membershipId });
	check(r.body.data?.delegationmembership_status_put === "Done", "the member accepts", r.body);

	// ---- acting as the account
	r = await member.get("Viewer", {}, owner.id);
	check(r.body.data?.viewer?.user_results?.result?.rest_id === owner.id, "Viewer answers as the shared account", r.body);
	r = await member.get("DelegatedAccountListQuery", {}, owner.id);
	check(r.body.data?.viewer_v2?.list_delegation_groups?.some((g: any) => g.handle?.result?.rest_id === owner.id), "the account menu still lists the member's own delegations while switched", r.body);
	r = await member.gql("CreateTweet", { tweet_text: `delegate test ${Date.now()}` }, owner.id);
	const postId = r.body.data?.create_tweet?.tweet_results?.result?.rest_id;
	if (postId) made.push(postId);
	const [author] = postId ? await sql`select user_id::text from posts where id = ${postId}::bigint` : [];
	check(author?.user_id === owner.id, "a post made while switched is the account's", r.body);
	r = await other.get("Viewer", {}, owner.id);
	check(r.status === 403, "a non-member can't act as the account", r.status);

	// ---- what a delegate may not do
	r = await member.rest("POST", "/1.1/account/settings.json", owner.id, "protected=true");
	check(r.status === 403, "settings can't be changed", r.status);
	r = await member.rest("GET", "/1.1/account/settings.json", owner.id);
	check(r.status === 200 && r.body.screen_name === ownerName, "but they can be read", r.body);
	r = await member.gql("UserPreferencesMutation", { allow_for_you_recommendations: false }, owner.id);
	check(r.status === 403, "preferences can't be changed", r.status);
	r = await member.gql("useDelegateMutation_settings_Mutation", { userId: owner.id, invitationSetting: "Everyone" }, owner.id);
	check(r.status === 403, "the account's delegation setting can't be changed", r.status);
	r = await member.gql("DisableUserAccountLabel", {}, owner.id);
	check(r.status === 403, "the automation label can't be changed", r.status);
	r = await member.get("XChatDmSettingsQuery", {}, owner.id);
	check(r.status === 403, "chat is off-limits", r.status);
	r = await member.get("GetPublicKeysQuery", { ids: [owner.id], include_juicebox_tokens: true }, owner.id);
	check(r.status === 403, "the account's chat keys and key backup token are off-limits", r.status);
	r = await member.get("GetInboxPageRequestQuery", {}, owner.id);
	check(r.status === 403, "the account's inbox is off-limits", r.status);
	r = await member.gql("DeleteMessageMutation", { conversation_id: `${owner.id}-${other.id}`, sequence_ids: [] }, owner.id);
	check(r.status === 403, "the account's messages can't be deleted", r.status);
	r = await member.get("useFetchAnalyticsQuery", {}, owner.id);
	check(r.status === 403, "a Contributor can't see post analytics", r.status);
	r = await member.gql("useAddMemberModalMutation_add_Mutation", { userId: other.id, delegationGroupId: owner.id, selectedRole: "Contributor" }, owner.id);
	check(r.body.errors?.length, "a Contributor can't invite", r.body);

	// ---- Admins: Contributors only
	await sql`update delegation_members set role = 'Admin' where owner_id = ${owner.id}::bigint and member_id = ${member.id}::bigint`;
	await other.gql("useDelegateMutation_settings_Mutation", { userId: other.id, invitationSetting: "Everyone" });
	r = await member.get("useFetchAnalyticsQuery", {}, owner.id);
	check(r.status === 200, "an Admin sees post analytics", r.status);
	r = await member.gql("useAddMemberModalMutation_add_Mutation", { userId: other.id, delegationGroupId: owner.id, selectedRole: "Admin" }, owner.id);
	check(r.body.errors?.length, "an Admin can't make Admins", r.body);
	r = await member.gql("useAddMemberModalMutation_add_Mutation", { userId: other.id, delegationGroupId: owner.id, selectedRole: "Contributor" }, owner.id);
	check(r.body.data?.delegation_group_invite_member?.members?.some((m: any) => m.user_results?.result?.rest_id === other.id), "an Admin invites a Contributor", r.body);
	r = await member.get("MembersDelegateQuery", {}, owner.id);
	const members = r.body.data?.viewer_v2?.list_delegation_groups?.[0]?.members ?? [];
	check(members.length === 2, "the members page lists both while switched", r.body);
	const self = members.find((m: any) => m.user_results?.result?.rest_id === member.id);
	const otherInvite = members.find((m: any) => m.user_results?.result?.rest_id === other.id);
	r = await member.gql("useMemberMenuMutation_remove_Mutation", { membershipId: self?.rest_id }, owner.id);
	check(r.body.errors?.length, "an Admin can't remove an Admin", r.body);
	r = await member.gql("useMemberMenuMutation_cancel_invite_Mutation", { membershipId: otherInvite?.rest_id }, owner.id);
	check(r.body.data?.delegation_membership_cancel, "an Admin withdraws a Contributor's invite", r.body);

	// ---- the owner changes roles; leaving; a suspended owner
	r = await owner.gql("useChangeMemberRoleModalMutation_change_Mutation", { userId: self?.rest_id, selectedRole: "Contributor" });
	const [role] = await sql`select role from delegation_members where id = ${self?.rest_id ?? "0"}::bigint`;
	check(r.body.data?.delegationmembership_role_put === "Done" && role?.role === "Contributor", "the owner changes a role", r.body);
	await sql`update users set status = 'suspended' where id = ${owner.id}::bigint`;
	r = await member.get("Viewer", {}, owner.id);
	await sql`update users set status = 'active' where id = ${owner.id}::bigint`;
	check(r.status === 403, "nobody acts as a suspended account", r.status);
	r = await member.gql("GroupMenuMutation", { membershipId: self?.rest_id });
	check(r.body.data?.delegation_membership_delete, "the member leaves", r.body);
	r = await member.get("Viewer", {}, owner.id);
	check(r.status === 403, "and can't act as the account any more", r.status);

	// ---- automation
	const page = async (body: Record<string, string>) => {
		const res = await fetch(`${origin}/account/automation`, { method: "POST", headers: { cookie: member.cookie }, body: new URLSearchParams({ csrf: member.csrf, ...body }), redirect: "manual" });
		return { status: res.status, text: await res.text() };
	};
	let p = await page({ owner: ownerName, password: "wrong-password" });
	check(p.status === 400 && p.text.includes("Wrong username or password"), "a wrong password doesn't connect", p.status);
	p = await page({ owner: memberName, password });
	check(p.status === 400, "an account can't run itself", p.status);
	p = await page({ owner: `@${ownerName}`, password });
	check(p.status === 303, "the managing account's password connects it", p.status);
	r = await member.get("UserAccountLabel", { rest_id: member.id });
	check(r.body.data?.user?.result?.account_label?.managed_label?.owner_screen_name === ownerName, "Settings > Automation shows the managing account", r.body);
	r = await other.get("UserByScreenName", { screen_name: memberName });
	const label = r.body.data?.user?.result?.affiliates_highlighted_label?.label;
	check(label?.userLabelType === "AutomatedLabel" && label.longDescription?.text === `Automated by @${ownerName}`, "the profile reads Automated by", r.body.data?.user?.result?.affiliates_highlighted_label);
	await sql`update users set automated_by = ${member.id}::bigint where id = ${other.id}::bigint`;
	const res = await fetch(`${origin}/account/automation`, { method: "POST", headers: { cookie: owner.cookie }, body: new URLSearchParams({ csrf: owner.csrf, owner: otherName, password }), redirect: "manual" });
	check(res.status === 400, "an automated account can't manage another", res.status);
	r = await member.gql("DisableUserAccountLabel");
	r = await member.get("UserAccountLabel", { rest_id: member.id });
	check(!r.body.data?.user?.result?.account_label?.managed_label, "disconnecting removes the label", r.body);
	const flow = await fetch(`${origin}/i/flow/enable_automated_account`, { headers: { cookie: member.cookie }, redirect: "manual" });
	check(flow.headers.get("location") === "/account/automation", "X's automation flow opens our page", flow.headers.get("location"));
} finally {
	for (const id of made) await owner.gql("DeleteTweet", { tweet_id: id });
	await clear();
	for (const s of saved) await sql`update users set delegation_invites = ${s.delegation_invites}, automated_by = ${s.automated_by}::bigint where id = ${s.id}::bigint`;
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
