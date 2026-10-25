// Settings > Post details: an opened post laid out as Twitter had it, with
// how many reposts, quotes, likes and bookmarks it has on a row of its own
// above the buttons, each opening the list of who did it. The client still
// has those pages (/retweets, /retweets/with_comments, /likes); X only took
// away the row. Kept in users.preferences.classic_post_details; the page
// script below draws the row, from /i/api/xitter/post-counts.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { getPost } from "./posts";

const CSS = `.choices{display:grid;gap:8px;margin-bottom:16px}
.choice{display:flex;align-items:flex-start;gap:12px;margin:0;border:1px solid var(--border);border-radius:16px;padding:12px 14px;cursor:pointer;font-size:15px;line-height:20px;color:var(--text)}
.choice:has(input:checked){border-color:var(--text)}
.choice input{width:20px;min-height:20px;height:20px;margin:0;padding:0;flex:none;accent-color:var(--accent)}
@media (hover:hover){.choice:hover{background:var(--hover)}}`;

async function page(req: Request, viewer: Viewer, classic: boolean, error = "") {
	const choice = (value: string, on: boolean, title: string, text: string) =>
		`<label class="choice"><input type="radio" name="layout" value="${value}"${on ? " checked" : ""}><span><b>${esc(title)}</b><br><span class="dim">${esc(text)}</span></span></label>`;
	return accountPage({
		req,
		viewer,
		title: "Post details",
		css: CSS,
		status: error ? 400 : 200,
		body: `<h1>Post details</h1>
<p class="dim">How an opened post shows its reposts, quotes, likes and bookmarks.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/account/post-details">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<div class="choices">
${choice("new", !classic, "New", "The counts sit next to the buttons under the post, as on X.")}
${choice("classic", classic, "Classic", "The counts get a row of their own above the buttons, as Twitter had them. Each opens who reposted, quoted or liked the post, and the likes show to everyone, not only to the post's author.")}
</div>
<button type="submit">Save</button>
</form>`,
	});
}

export async function classicDetailRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer, !!viewer.classic_post_details);
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, !!viewer.classic_post_details, "That form is out of date. Try again.");
	const layout = String(form?.get("layout") ?? "");
	if (layout !== "new" && layout !== "classic") return page(req, viewer, !!viewer.classic_post_details, "Choose a layout.");
	await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{classic_post_details}', ${layout === "classic" ? "true" : "false"}::text::jsonb) where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/post-details" } });
}

// GET /i/api/xitter/post-counts?id=<post>: the counts the row shows, by the
// same rules as the post's own (count overrides, suspended accounts left out)
export async function postCounts(viewerId: string, url: URL): Promise<Response> {
	const id = url.searchParams.get("id") ?? "";
	const post = /^\d{1,19}$/.test(id) ? await getPost(viewerId, id) : undefined;
	if (!post) return Response.json({ error: "No such post." }, { status: 404 });
	return Response.json(
		{ reposts: post.repost_count, quotes: post.quote_count, likes: post.like_count, bookmarks: post.bookmark_count },
		{ headers: { "cache-control": "private, no-store" } },
	);
}

export const CLASSIC_DETAIL_CSS = `#xitter-counts{display:flex;flex-wrap:wrap;gap:4px 20px;padding:16px 4px;border-top:1px solid rgba(128,128,128,.3);border-bottom:1px solid rgba(128,128,128,.3);font:15px TwitterChirp,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:rgb(113,118,123)}
#xitter-counts a,#xitter-counts span.xc-item{color:inherit;text-decoration:none;white-space:nowrap}
#xitter-counts a:hover{text-decoration:underline}
#xitter-counts b{color:var(--xt-text,rgb(231,233,234));font-weight:700}
html[style*="color-scheme: light"] #xitter-counts b{color:rgb(15,20,25)}
[data-xitter-classic] [role="group"] :is([data-testid="retweet"],[data-testid="unretweet"],[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"],[data-testid="removeBookmark"]) [data-testid="app-text-transition-container"]{display:none}`;

export const CLASSIC_DETAIL_SCRIPT = String.raw`(function(){
	var X=window.__XITTER__||{};
	if(!X.classicDetail)return;
	var counts={},asking={};
	function word(n,one,many){return n===1?one:many}
	function number(n){
		try{return n<10000?n.toLocaleString():new Intl.NumberFormat(undefined,{notation:"compact",maximumFractionDigits:1}).format(n)}catch(e){return String(n)}
	}
	function focal(){
		var m=/^\/([^\/]+)\/status\/(\d+)\/?$/.exec(location.pathname);
		if(!m)return null;
		var article=document.querySelector('[data-testid="primaryColumn"] article[data-testid="tweet"][tabindex="-1"]');
		if(!article)return null;
		var bar=null,groups=article.querySelectorAll('[role="group"]');
		for(var i=0;i<groups.length;i++)if(groups[i].querySelector('[data-testid="reply"]'))bar=groups[i];
		return bar?{user:m[1],id:m[2],article:article,bar:bar}:null;
	}
	function ask(id,label){
		if(asking[id]===label)return;
		asking[id]=label;
		fetch("/i/api/xitter/post-counts?id="+id,{credentials:"include"}).then(function(r){return r.ok?r.json():null}).then(function(c){
			if(c)counts[id]=c;
			draw();
		}).catch(function(){});
	}
	function item(n,one,many,href){
		var el=document.createElement(href?"a":"span");
		if(href){
			el.href=href;
			el.addEventListener("click",function(e){
				if(e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
				e.preventDefault();
				if(window.__xitterGo)window.__xitterGo(href);else location.assign(href);
			});
		}else el.className="xc-item";
		var b=document.createElement("b");
		b.textContent=number(n);
		el.appendChild(b);
		el.appendChild(document.createTextNode(" "+word(n,one,many)));
		return el;
	}
	function draw(){
		var f=focal(),old=document.getElementById("xitter-counts");
		if(!f){if(old)old.remove();return}
		f.article.setAttribute("data-xitter-classic","");
		// the bar's label carries its counts: a like or repost changes it, and the row follows
		var label=f.bar.getAttribute("aria-label")||"";
		if(asking[f.id]!==label)ask(f.id,label);
		var c=counts[f.id];
		var key=f.id+":"+(c?[c.reposts,c.quotes,c.likes,c.bookmarks].join(","):"");
		if(old&&old.getAttribute("data-key")===key&&old.nextSibling===f.bar)return;
		if(old)old.remove();
		if(!c||!(c.reposts||c.quotes||c.likes||c.bookmarks))return;
		var base="/"+f.user+"/status/"+f.id;
		var row=document.createElement("div");
		row.id="xitter-counts";
		row.setAttribute("data-key",key);
		if(c.reposts)row.appendChild(item(c.reposts,"Repost","Reposts",base+"/retweets"));
		if(c.quotes)row.appendChild(item(c.quotes,"Quote","Quotes",base+"/retweets/with_comments"));
		if(c.likes)row.appendChild(item(c.likes,"Like","Likes",base+"/likes"));
		if(c.bookmarks)row.appendChild(item(c.bookmarks,"Bookmark","Bookmarks",null));
		f.bar.parentNode.insertBefore(row,f.bar);
	}
	var pending=false;
	new MutationObserver(function(){
		if(pending)return;
		pending=true;
		requestAnimationFrame(function(){pending=false;draw()});
	}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["aria-label"]});
	draw();
})();`;
