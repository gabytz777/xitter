// More than one badge after a name. X's client draws a single badge there
// (affiliates_highlighted_label); model.ts puts the first of an account's
// badges in it, and this page script adds the others right after it, wherever
// the client shows that badge: posts, profiles, account lists, hover cards.

import { sql } from "./db";
import { ID_RE, INSTANCE_ID, baseUrl, listedInstance } from "./federation";
import { STAFF_HANDLE } from "./invites";
import { badgeList, labelTakesSlot } from "./model";
import { toUser, userCols } from "./users";

// GET /i/api/xitter/badges?names=a,b: { a: { badges: [{ url, description }], gold }, ... },
// only accounts that wear more than one badge, or a gold translator globe
// (X's yellow "moderator" globe, recoloured for translator moderators)
export async function extraBadges(viewerId: string, url: URL): Promise<Response> {
	const names = [...new Set((url.searchParams.get("names") ?? "").split(",").map((n) => n.trim().toLowerCase()).filter((n) => {
		const at = n.indexOf("@");
		return at < 0 ? STAFF_HANDLE.test(n) : STAFF_HANDLE.test(n.slice(0, at)) && /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(n.slice(at + 1));
	}))].slice(0, 50);
	const out: Record<string, { badges: { url: string; description: string }[]; gold: boolean }> = {};
	if (names.length) {
		const rows = await sql`select ${userCols(viewerId)} from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")})`;
		for (const r of rows) {
			const u = toUser(r);
			const badges = badgeList(u).slice(labelTakesSlot(u) ? 0 : 1).map(({ url, description }) => ({ url, description }));
			const gold = u.translator === "moderator";
			if (badges.length || gold) out[u.screen_name.toLowerCase()] = { badges, gold };
		}
	}
	return Response.json(out, { headers: { "cache-control": "private, max-age=60" } });
}

// GET /i/api/xitter/instance?id=example.org: what the globe badge's card shows
// about an instance accounts come from. Only instances this one knows: on the
// list, or with accounts here.
export async function instanceCard(viewerId: string, url: URL): Promise<Response> {
	const id = (url.searchParams.get("id") ?? "").toLowerCase();
	if (!ID_RE.test(id) || id === INSTANCE_ID) return Response.json({ error: "unknown instance" }, { status: 404 });
	const listed = listedInstance(id);
	const [r] = await sql`select (select count(*)::int from users where instance = ${id}) as accounts,
		coalesce(me.preferences->'hidden_instances', '[]'::jsonb) ? ${id} or me.preferences->>'hide_federated' = 'true' as hidden
		from users me where me.id = ${viewerId}::bigint`;
	if (!listed && !r?.accounts) return Response.json({ error: "unknown instance" }, { status: 404 });
	return Response.json(
		{
			id,
			name: listed?.name ?? id,
			state: listed?.state ?? "unlisted",
			home: baseUrl(id),
			rules: `${baseUrl(id)}/rules`,
			source: listed?.source_url ?? null,
			accounts: r?.accounts ?? 0,
			hidden: !!r?.hidden,
		},
		{ headers: { "cache-control": "private, max-age=60" } },
	);
}

export const BADGES_SCRIPT = String.raw`(function(){
	var known={},waiting={},timer,queue=[];
	// the containers that show a name with its badge; the account is the "@name" in them
	var SEL='[data-testid="User-Name"],[data-testid="UserName"],[data-testid="UserCell"],[data-testid="HoverCard"],[data-testid="SideNav_AccountSwitcher_Button"],[data-testid="primaryColumn"] h2';
	function handle(box){
		var spans=box.querySelectorAll("span");
		for(var i=0;i<spans.length;i++){var full=spans[i].getAttribute("data-xitter-handle");if(full)return full;var m=/^@([^\s\/\?#@%,:]{1,50}(?:@[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?)?)$/.exec(spans[i].textContent);if(m)return m[1].toLowerCase()}
		// a profile's top bar has the name but no handle: the page's address does
		if(box.tagName==="H2"&&box.querySelector('div[style*="height: calc(1.0625em)"]')){var p=/^\/([^\/?#]{1,150})(?:\/|$)/.exec(location.pathname);if(p)try{return decodeURIComponent(p[1]).toLowerCase()}catch(e){}}
	}
	// names show "@name" for someone from another instance; the whole handle
	// stays on the element (and its tooltip), and the globe badge says where
	// they're from. Only the text changes, in place, so the client's own copy
	// of it stays its own: when it writes the long one back, it's shortened again.
	function shorten(box){
		var spans=[box].concat([].slice.call(box.querySelectorAll("span, a")));
		for(var i=0;i<spans.length;i++){
			var t=spans[i].firstChild;
			if(!t||t.nodeType!==3||spans[i].childNodes.length!==1)continue;
			var m=/^@([^\s\/\?#@%,:]{1,50})@([a-zA-Z0-9.-]{1,253}(?::\d{1,5})?)$/.exec(t.nodeValue);
			if(!m)continue;
			spans[i].setAttribute("data-xitter-handle",(m[1]+"@"+m[2]).toLowerCase());
			spans[i].title="@"+m[1]+"@"+m[2];
			t.nodeValue="@"+m[1];
		}
	}
	// the same inside running text ("Replying to @a@x.org and @b@y.org")
	function shortenText(box){
		var walk=document.createTreeWalker(box,NodeFilter.SHOW_TEXT),t,full=[];
		while((t=walk.nextNode())){
			var v=t.nodeValue,next=v.replace(/@([^\s\/\?#@%,:]{1,50})@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::\d{1,5})?)/g,function(all,name){full.push(all);return "@"+name});
			if(next!==v)t.nodeValue=next;
		}
		if(full.length)box.title=full.join(", ");
	}
	function draw(box,name){
		var k=known[name];
		// the translator globe X draws (its label is the client's "Translator account")
		if(k.gold)box.querySelectorAll('svg[aria-label="Translator account"]').forEach(function(g){g.style.setProperty("color","#d4a72c","important")});
		if(!k.badges.length)return;
		// X's own badge: a square box sized to the text, after the name
		var slot=box.querySelector('div[style*="height: calc(1.0625em)"]');
		var holder,inside;
		// this name's rows, not those of a name inside it (a hover card's)
		var mine=[].filter.call(box.querySelectorAll("[data-xitter-badges]"),function(r){return r.closest(SEL)===box});
		if(slot){
			holder=slot.parentElement;
			// anywhere in the row, not only right after: the client can draw its
			// translator globe between X's badge and ours, and ours came twice
			var here=holder.parentElement&&holder.parentElement.querySelector(":scope > [data-xitter-badges]");
			// a row put at the end of the name before X's badge box was drawn goes,
			// or the badges show twice
			mine.forEach(function(r){if(r!==here)r.remove()});
			if(here)return;
		}else{
			if(mine.length)return;
			// no check and the slot taken by a label (automated, parody, staff-made):
			// X draws no badge box, so the badges go at the end of the name itself
			var nameDiv=box.querySelector('div[dir="ltr"]');
			inside=nameDiv&&nameDiv.firstElementChild;
			if(!inside||inside.querySelector("[data-xitter-badges]"))return;
		}
		var row=document.createElement("span");
		row.setAttribute("data-xitter-badges","");
		row.style.cssText="display:inline-flex;align-items:center;vertical-align:text-bottom";
		k.badges.forEach(function(b){
			var img=document.createElement("img");
			img.src=b.url;img.alt=b.description;img.title=b.description;img.draggable=false;
			img.style.cssText="height:1.0625em;width:1.0625em;object-fit:contain;margin-left:2px;border-radius:2px";
			row.appendChild(img);
		});
		if(holder)holder.after(row);else inside.appendChild(row);
	}
	function scan(){
		document.querySelectorAll(SEL).forEach(function(box){
			shorten(box);
			var name=handle(box);
			if(!name)return;
			if(known[name]){draw(box,name);return}
			if(known[name]===undefined&&!waiting[name]){waiting[name]=true;queue.push(name)}
		});
		// the accounts under the search box carry no badge, only the handle
		document.querySelectorAll('[data-testid="TypeaheadUser"]').forEach(shorten);
		// "Replying to @name@example.org" on posts and in the reply composer: links
		// to accounts from other instances, and the composer's button that names them
		document.querySelectorAll('a[href*="@"]').forEach(shorten);
		document.querySelectorAll('[role="dialog"] [role="button"], [data-testid="primaryColumn"] [role="button"]').forEach(function(b){
			if(b.textContent.indexOf("Replying to")===0&&b.textContent.indexOf("@",1)>=0)shortenText(b);
		});
		if(queue.length)load();
	}
	function load(){
		var names=queue.splice(0,50);
		fetch("/i/api/xitter/badges?names="+names.join(","),{credentials:"same-origin"})
			.then(function(r){return r.json()})
			.then(function(d){names.forEach(function(n){known[n]=d[n]||null;delete waiting[n]});scan()})
			.catch(function(){names.forEach(function(n){delete waiting[n]})});
	}
	// the globe badge on accounts from other instances opens a card about the
	// instance: its name, rules, source code, and the switch to hide it
	var card,STATES={active:"",suspended:"Suspended on the instance list",blocked:"Blocked on the instance list",unlisted:"Not on the instance list"};
	function globeOf(el){
		for(var n=el,i=0;n&&n.nodeType===1&&i<5;n=n.parentElement,i++){
			var s=(n.getAttribute("src")||"")+" "+(n.style&&n.style.backgroundImage||"");
			var m=/\/public\/globe\.svg\?from=([^"')&\s]+)/.exec(s);
			if(m)try{return decodeURIComponent(m[1])}catch(e){return}
		}
	}
	function closeCard(){if(card){card.remove();card=null}}
	function el(tag,css,text){var e=document.createElement(tag);if(css)e.style.cssText=css;if(text)e.textContent=text;return e}
	function link(href,text,color){var a=el("a","color:"+color+";text-decoration:none;font-weight:700",text);a.href=href;if(/^https?:/.test(href)){a.target="_blank";a.rel="noopener noreferrer"}return a}
	function openCard(id,at){
		closeCard();
		var light=/^rgb\(255, 255, 255/.test(getComputedStyle(document.body).backgroundColor);
		var fg=light?"#0f1419":"#e7e9ea",muted=light?"#536471":"#71767b",accent="#1d9bf0";
		card=el("div","position:fixed;z-index:10000;width:280px;max-width:calc(100vw - 32px);padding:16px;border-radius:16px;font:15px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"+
			"background:"+(light?"#fff":"#000")+";color:"+fg+";box-shadow:"+(light?"rgba(101,119,134,.2) 0 0 15px, rgba(101,119,134,.15) 0 0 3px 1px":"rgba(255,255,255,.2) 0 0 15px, rgba(255,255,255,.15) 0 0 3px 1px"));
		card.setAttribute("role","dialog");
		card.appendChild(el("div","color:"+muted,"Loading…"));
		var r=at.getBoundingClientRect();
		card.style.left=Math.max(16,Math.min(r.left,innerWidth-296))+"px";
		card.style.top=(r.bottom+248>innerHeight?Math.max(16,r.top-232):r.bottom+8)+"px";
		document.body.appendChild(card);
		var mine=card;
		fetch("/i/api/xitter/instance?id="+encodeURIComponent(id),{credentials:"same-origin"})
			.then(function(x){return x.ok?x.json():null})
			.then(function(d){
				if(card!==mine)return;
				card.textContent="";
				if(!d){card.appendChild(el("div","color:"+muted,"Couldn't load this instance."));return}
				card.appendChild(el("div","font-weight:800;font-size:17px",d.name));
				card.appendChild(el("div","color:"+muted,d.id));
				if(STATES[d.state])card.appendChild(el("div","color:#f4212e;margin-top:4px",STATES[d.state]));
				card.appendChild(el("div","color:"+muted+";margin-top:8px",(d.accounts===1?"1 account":d.accounts+" accounts")+" here"+(d.hidden?" · hidden for you":"")));
				var links=el("div","display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px");
				links.appendChild(link(d.rules,"Rules",accent));
				if(d.source)links.appendChild(link(d.source,"Source code",accent));
				links.appendChild(link(d.home,"Visit",accent));
				links.appendChild(link("/account/instances",d.hidden?"Hidden instances":"Hide this instance",accent));
				card.appendChild(links);
			})
			.catch(function(){if(card===mine){card.textContent="";card.appendChild(el("div","color:"+muted,"Couldn't load this instance."))}});
	}
	document.addEventListener("click",function(e){
		if(card&&card.contains(e.target))return;
		var id=globeOf(e.target);
		if(!id){closeCard();return}
		// the badge sits inside a post or a profile link: only the card opens
		e.preventDefault();e.stopPropagation();
		openCard(id,e.target);
	},true);
	document.addEventListener("keydown",function(e){if(e.key==="Escape")closeCard()});
	addEventListener("scroll",closeCard,true);
	var style=document.createElement("style");
	style.textContent='img[src*="/public/globe.svg?from="]{cursor:pointer}';
	document.head.appendChild(style);
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;scan()},120)}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
})();`;
