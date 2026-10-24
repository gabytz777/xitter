export function patchCountryAudience(text: string): string {
	let out = text;
	out = out.replace(/"co"===([\w$]+)(?=&&null!=[\w$]+&&[\w$]+\.length>0|\?"all")/g, '["co","country"].includes($1)');
	out = out.replace(/"co"===([\w$]+)&&null==([\w$]+)/g, '["co","country"].includes($1)&&null==$2');
	out = out.replace(/conversationControlRegionCodes:([\w$]+)\.includes\("co"\)\?([\w$]+):void 0/g, 'conversationControlRegionCodes:($1.includes("co")||$1.includes("country"))?$2:void 0');
	if (!out.includes("defersChangesUntilApply:") || !out.includes('.restrictions.includes("co")')) return out;
	return out.replace(/function [\w$]+\(\{defersChangesUntilApply:[\s\S]{0,160}?\}\)\{[\s\S]{0,16000}?(?=let [\w$]+=[\w$]+\.A\.create)/g, (menu) => {
		const navigator = /options:([\w$]+)\.options/.exec(menu)?.[1];
		let patched = menu;
		if (!navigator) return menu;
		patched = patched.replace(/([\w$]+=[\w$]+=>\{let [\w$]+;)([\s\S]*?)(\},[\w$]+=\{isEveryone:)/g, (callback, start, body, end) => {
			if (!body.includes('.restrictions.includes("co")')) return callback;
			return start + body.replace(/"co"/g, `(${navigator}?.id??"co")`) + end;
		});
		patched = patched.replace(/requiresSelection:([\w$]+)\.every\(([\w$]+)=>"co"===\2\)/g, 'requiresSelection:$1.every($2=>["co","country"].includes($2))');
		patched = patched.replace(/value:([\w$]+)\.includes\("co"\)\?/g, `value:$1.includes(${navigator}.id)?`);
		return patched.replace(/(?<![\w$.])([\w$]+(?:\.[\w$]+)*)\.includes\("co"\)(?!\|\|\1\.includes\("country"\))/g, '($1.includes("co")||$1.includes("country"))');
	});
}
