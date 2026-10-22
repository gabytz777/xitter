import { conversationCard } from "./conversation-cards";
import { forbiddenText } from "./names";
import { PostError, refuseHate } from "./posts";

export async function checkConversationCard(userId: string, raw: unknown, draft = false) {
	let card: ReturnType<typeof conversationCard>, text: string;
	let fields: string[];
	try { card = conversationCard(raw, () => false, draft); }
	catch (error) { throw new PostError(error instanceof Error ? error.message : "Invalid conversation card.", 214); }
	fields = [card.title, card.thanks, card.thanksUrl ?? "", card.thanksDisplayUrl ?? "", ...card.choices.flatMap((choice) => [choice.hashtag, choice.text])];
	for (text of fields) await refuseHate(userId, text);
	if (forbiddenText(...fields)) throw new PostError("A conversation card contains text this instance doesn't allow.", 214);
	return card;
}
