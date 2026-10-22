import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { patchText } from "../src/patch";

test("native unsent selection announces the complete request for card restoration", () => {
	const original = '_handleClick=e=>()=>{let t=e.scheduling_info&&e.scheduling_info.execute_at;if(!this.isDraftsTab&&!t)return;open(e)}';
	const patched = patchText(original);
	expect(patched).toContain('document.dispatchEvent(new CustomEvent("xitter:restore-conversation-cards",{detail:e.tweet_create_request}))');
	expect(patched).toContain('let t=e.scheduling_info&&e.scheduling_info.execute_at;if(!this.isDraftsTab&&!t)return;open(e)');
});

test("card-only changes participate in the native draft confirmation", () => {
	const patched = patchText('_areComposersEmptyOrUnchanged=()=>{return this.props.composerData.every(empty)}');
	expect(patched).toContain('if(!this.props.isInline&&window.__XITTER_CONVERSATION_HAS_DRAFT__?.())return!1;');
});

test("the draft hooks match the pinned client modules when present", async () => {
	const client = join(process.env.CLIENT_DIR ?? "client", "abs/responsive-web/client-web");
	const files = await readdir(client).catch(() => []);
	const scheduling = files.find((name) => /^ondemand.ComposeScheduling\./.test(name));
	const compose = files.find((name) => /^shared~bundle.Compose~bundle.RichTextCompose\./.test(name));
	let original: string;
	if (scheduling) {
		original = await readFile(join(client, scheduling), "utf8");
		expect(patchText(original)).toContain('new CustomEvent("xitter:restore-conversation-cards"');
		expect(patchText(original)).toContain("window.__XITTER_CONVERSATION_DRAFT_LABEL__");
		expect(() => new Function(patchText(original))).not.toThrow();
	}
	if (compose) {
		original = await readFile(join(client, compose), "utf8");
		expect(patchText(original)).toContain('window.__XITTER_CONVERSATION_HAS_DRAFT__?.()');
		expect(() => new Function(patchText(original))).not.toThrow();
	}
});
