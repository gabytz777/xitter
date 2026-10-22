import { eld } from "eld/extrasmall";

export function guessLang(input: string): string {
	const text = input
		.slice(0, 600)
		.replace(/https?:\/\/\S+|[@#][\p{L}\p{N}_.@-]+/gu, " ")
		.trim();
	if (!/\p{L}/u.test(text)) return "und";
	const result = eld.detect(text);
	return result.language && result.isReliable() ? result.language : "und";
}
