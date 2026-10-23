// X Money in the client (money.ts): payment and "Pay @name" cards drawn over
// the summary card of a post carrying a payment's or request's link, the
// composer's $ button that puts a Pay button or one of your payments in the
// post, and opening the composer with one in it from the Money pages
// (window.__xitterCompose).

import { MONEY_ICON } from "./tidy";

// The card's look, shared by the client and the payment page (money.ts).
// Colours come from the text around it, so it fits light, dim and dark.
export const CARD_CSS = `.xm-card{display:block;position:relative;overflow:hidden;margin-top:12px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:16px;color:inherit;text-decoration:none;font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:20px;transition:background-color .2s}
.xm-card:hover{background:color-mix(in srgb,currentColor 3%,transparent);text-decoration:none}
.xm-card b{font-weight:700}
.xm-dim{color:color-mix(in srgb,currentColor 55%,transparent)}
.xm-badge{width:18px;height:18px;vertical-align:-3px;margin-left:2px;flex:none}
img.xm-org{width:16px!important;height:16px!important;border-radius:3px!important;outline:0!important;object-fit:cover;vertical-align:-2px;margin-left:3px;flex:none;box-shadow:0 0 0 1px color-mix(in srgb,currentColor 20%,transparent)}
.xm-who{display:inline-flex;align-items:center;min-width:0;max-width:100%}
.xm-who b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
img.xm-sq{border-radius:8px!important}
.xm-card[data-xm-go]{cursor:pointer}
.xm-row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.xm-amt{font-size:36px;line-height:44px;font-weight:800;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.xm-p2p{padding:12px 16px 14px}
.xm-p2p .xm-line{font-size:17px;margin:2px 0 4px}
.xm-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.xm-faces{display:flex;flex:none}
.xm-faces>img{width:32px;height:32px;border-radius:50%;object-fit:cover;background:color-mix(in srgb,currentColor 15%,transparent)}
.xm-faces img+img{margin-left:-8px;box-shadow:0 0 0 2px var(--xm-bg,#000)}
.xm-buy{display:flex;align-items:center;gap:12px;padding:12px 16px}
.xm-buy .xm-logo{width:48px;height:48px;border-radius:10px;object-fit:cover;flex:none}
.xm-buy .xm-line{font-size:17px}
.xm-grow{flex:1;min-width:0}
.xm-end{align-self:end;font-size:14px}
.xm-shop .xm-banner{height:84px;background:center/cover no-repeat color-mix(in srgb,currentColor 15%,transparent)}
.xm-shop .xm-body{padding:0 16px 14px}
.xm-shop .xm-logo{display:block;width:56px;height:56px;margin-top:-28px;border-radius:12px;object-fit:cover;border:2px solid var(--xm-bg,#000);background:var(--xm-bg,#000)}
.xm-shop .xm-row{margin-top:8px;font-size:17px}
.xm-rule{height:1px;margin:12px 0 6px;background:color-mix(in srgb,currentColor 18%,transparent)}
.xm-req{display:flex;align-items:center;gap:12px;padding:14px 16px}
.xm-req .xm-line{font-size:17px;line-height:22px}
.xm-req .xm-logo{width:44px;height:44px;border-radius:10px;object-fit:cover;flex:none}
.xm-req .xm-sub{font-size:15px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xm-pay{flex:none;display:inline-flex;align-items:center;min-height:40px;padding:0 22px;border-radius:9999px;background:var(--xm-fg,#fff);color:var(--xm-bg,#000)!important;font-weight:700;font-size:17px;text-decoration:none!important}
.xm-pay:hover{opacity:.9}
.xm-state{flex:none;padding:6px 14px;border-radius:9999px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);color:color-mix(in srgb,currentColor 60%,transparent);font-weight:700;font-size:14px}
.xm-mark{display:inline-flex;align-items:center;gap:1px;font-weight:700;color:var(--xm-text,currentColor)}
.xm-mark svg{width:16px;height:16px;fill:currentColor}`;

export const MONEY_UI_CSS = `${CARD_CSS}
[data-xm-hidden]{display:none!important}
[data-xm-link]{font-size:0!important;line-height:0!important}
[data-xm-compose]{position:relative;margin:4px 0 8px}
[data-xm-compose] .xm-card{margin-top:0;cursor:default}
[data-xm-compose] .xm-card:hover{background:none}
.xm-remove{position:absolute;top:8px;right:8px;z-index:1;display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:rgb(15 20 25 / .75);color:#fff;font:20px/1 -apple-system,"Segoe UI",sans-serif;cursor:pointer;backdrop-filter:blur(4px)}
.xm-remove:hover{background:rgb(39 44 48 / .75)}
[data-xm-compose] .xm-req{padding-right:56px}
[data-xm-compose] .xm-req .xm-pay{pointer-events:none}
#xitter-pay{position:fixed;z-index:10000;width:360px;max-width:calc(100vw - 16px);max-height:min(440px,calc(100vh - 16px));display:flex;flex-direction:column;border-radius:16px;overflow:hidden;font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:15px;box-shadow:rgba(101,119,134,.2) 0 0 15px,rgba(101,119,134,.15) 0 0 3px 1px}
#xitter-pay .xp-head{padding:12px 16px;font-weight:800;font-size:17px;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}
#xitter-pay .xp-list{overflow-y:auto}
#xitter-pay .xp-item{display:flex;align-items:center;gap:12px;width:100%;padding:10px 16px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
#xitter-pay .xp-item:hover,#xitter-pay .xp-item:focus-visible{background:color-mix(in srgb,currentColor 6%,transparent);outline:0}
#xitter-pay .xp-item>img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none}
#xitter-pay .xp-text{flex:1;min-width:0}
#xitter-pay .xp-text div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#xitter-pay .xp-dim{color:color-mix(in srgb,currentColor 55%,transparent);font-size:14px}
#xitter-pay .xp-foot{padding:12px 16px;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent)}
#xitter-pay .xp-send{display:block;width:100%;min-height:36px;border:0;border-radius:9999px;background:var(--xt-accent,#1d9bf0);color:#fff;font:inherit;font-weight:700;cursor:pointer}
#xitter-pay .xp-icon{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#000;flex:none;box-shadow:inset 0 0 0 1px rgb(255 255 255 / .15)}
#xitter-pay .xp-icon svg{width:26px;height:26px;fill:#fff}
#xitter-pay .xp-label{padding:12px 16px 4px;font-size:13px;font-weight:700;color:color-mix(in srgb,currentColor 55%,transparent)}
#xitter-pay .xp-empty{padding:24px 16px;text-align:center;color:color-mix(in srgb,currentColor 55%,transparent)}`;

export const MONEY_UI_SCRIPT = `(function(){
	var X=window.__XITTER__||{},T=X.tidy||{};
	// with Money switched off, posts keep their cards; the composer gets nothing
	var on=(T.links||[]).some(function(l){return l.href==="/account/money"});
	// a payment's (p) or a request's (r) address, as "p<id>" or "r<id>"
	var KEY=/\\/i\\/xmoney\\/([pr])\\/(\\d{1,19})(?:[/?#]|$)/;
	function keyOf(href){var m=KEY.exec(href||"");return m?m[1]+m[2]:null}
	function go(p){if(window.__xitterGo)window.__xitterGo(p);else location.assign(p)}
	function bg(){var b=getComputedStyle(document.body).backgroundColor;return b&&b!=="rgba(0, 0, 0, 0)"?b:"#fff"}
	function csrf(){return (document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/)||[])[1]||""}

	// the composer with a payment in it: the text waits for the editor to appear
	window.__xitterCompose=function(text){
		try{sessionStorage.setItem("xitter-compose",text)}catch(e){}
		go("/compose/post");
	};
	function editorOf(root){return root&&root.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]')}
	function insert(editor,text){
		editor.focus();
		var sel=getSelection(),range=document.createRange();
		range.selectNodeContents(editor);range.collapse(false);
		sel.removeAllRanges();sel.addRange(range);
		var before=(editor.innerText||"").replace(/\\n+$/,"");
		document.execCommand("insertText",false,(before&&!/\\s$/.test(before)?" ":"")+text);
	}
	function pending(){
		var text;try{text=sessionStorage.getItem("xitter-compose")}catch(e){}
		if(!text)return;
		var editor=document.querySelector('[role="dialog"] [contenteditable="true"][data-testid="tweetTextarea_0"]')||document.querySelector('[contenteditable="true"][data-testid="tweetTextarea_0"]');
		if(!editor)return;
		try{sessionStorage.removeItem("xitter-compose")}catch(e){}
		setTimeout(function(){insert(editor,text)},50);
	}

	// cards: fetched as HTML per payment and the author it speaks for
	var cache={},asked={};
	function authorOf(el){
		var a=el.closest('article');
		var link=a&&a.querySelector('[data-testid="User-Name"] a[href^="/"]');
		return link?link.getAttribute("href").slice(1).split("/")[0].toLowerCase():"";
	}
	// preview: as other people will see it (the composer's mockup)
	function fetchCards(by,ids,preview){
		var tail=preview?"|preview":"";
		ids=ids.filter(function(id){return !asked[id+"|"+by+tail]});
		if(!ids.length)return;
		ids.forEach(function(id){asked[id+"|"+by+tail]=true});
		fetch("/i/api/xitter/money/cards?ids="+ids.join(",")+"&by="+encodeURIComponent(by)+(preview?"&preview=1":""),{credentials:"include"})
			.then(function(r){return r.ok?r.json():{}})
			.then(function(d){ids.forEach(function(id){cache[id+"|"+by+tail]=d[id]||null});cards();composers()},function(){});
	}
	function cards(){
		var want={};
		document.querySelectorAll('[data-testid="card.wrapper"]:not([data-xm-hidden])').forEach(function(w){
			var a=[].find.call(w.querySelectorAll("a[href]"),function(a){return keyOf(a.getAttribute("href"))});
			if(!a)return;
			var id=keyOf(a.getAttribute("href")),by=authorOf(w),key=id+"|"+by;
			if(cache[key]===undefined){(want[by]=want[by]||[]).push(id);return}
			if(!cache[key])return;
			var box=document.createElement("div");
			box.setAttribute("data-xm-card",id);
			box.style.setProperty("--xm-bg",bg());box.style.setProperty("--xm-fg",getComputedStyle(document.body).color);
			box.innerHTML=cache[key];
			w.setAttribute("data-xm-hidden","");
			w.parentNode.insertBefore(box,w.nextSibling);
			// the link in the text is the card's; the card shows it instead
			var art=w.closest("article");
			if(art)[].forEach.call(art.querySelectorAll('[data-testid="tweetText"] a[href]'),function(t){if(keyOf(t.getAttribute("href"))===id)t.setAttribute("data-xm-hidden","")});
		});
		// a card whose post the client drew again without it
		document.querySelectorAll("[data-xm-card]").forEach(function(c){var w=c.previousElementSibling;if(!w||!w.hasAttribute("data-xm-hidden"))c.remove()});
		for(var by in want)fetchCards(by,want[by]);
	}
	// a card opens its page, its Pay button the payment, inside the client
	document.addEventListener("click",function(e){
		var a=e.target.closest&&e.target.closest("[data-xm-card] [data-xm-go]");
		if(!a||e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;
		e.preventDefault();e.stopPropagation();
		go(a.getAttribute("data-xm-go"));
	},true);

	// the composer's $ button: a copy of its emoji button, like the sticker one
	var open=null;
	function close(){if(open){open.remove();open=null}}
	document.addEventListener("keydown",function(e){if(e.key==="Escape")close()},true);
	document.addEventListener("mousedown",function(e){if(open&&!open.contains(e.target)&&!e.target.closest("[data-xitter-pay]"))close()},true);
	function rootOf(toolbar){var r=toolbar;while(r&&!editorOf(r))r=r.parentElement;return r}
	function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n}
	function show(button,toolbar){
		close();
		var box=el("div");box.id="xitter-pay";
		box.style.background=bg();box.style.color=getComputedStyle(document.body).color;
		box.appendChild(el("div","xp-head","X Money"));
		var list=el("div","xp-list");
		function action(title,sub,run){
			var b=el("button","xp-item");b.type="button";
			var i=el("span","xp-icon");i.innerHTML='<svg viewBox="0 0 24 24"><path d="${MONEY_ICON}"></path></svg>';b.appendChild(i);
			var t=el("div","xp-text");t.appendChild(el("div",null,title));t.appendChild(el("div","xp-dim",sub));b.appendChild(t);
			b.onclick=run;list.appendChild(b);
		}
		// a "Pay @you" card anyone who sees the post can pay
		action("Add a Pay button","Anyone who sees the post can pay you",function(){
			fetch("/i/api/xitter/money/payme",{method:"POST",credentials:"include",headers:{"x-csrf-token":csrf()}}).then(function(r){return r.json()}).then(function(d){
				close();var ed=editorOf(rootOf(toolbar));if(ed&&d.url)insert(ed,d.url);
			},function(){});
		});
		action("Request money","Ask for an amount, from anyone or one account",function(){close();go("/account/money/request")});
		var loading=el("div","xp-empty","Loading…");list.appendChild(loading);
		box.appendChild(list);
		var foot=el("div","xp-foot"),send=el("button","xp-send","Send money");
		send.type="button";send.onclick=function(){close();go("/account/money/send")};
		foot.appendChild(send);box.appendChild(foot);
		document.body.appendChild(box);open=box;
		var r=button.getBoundingClientRect(),top=r.bottom+6;
		if(top+440>innerHeight)top=Math.max(8,r.top-6-Math.min(440,innerHeight-16));
		box.style.top=top+"px";box.style.left=Math.max(8,Math.min(r.left,innerWidth-box.offsetWidth-8))+"px";
		fetch("/i/api/xitter/money/recent",{credentials:"include"}).then(function(r){return r.ok?r.json():[]}).then(function(items){
			if(open!==box)return;
			loading.remove();
			if(!items.length)return;
			list.appendChild(el("div","xp-label","Your payments"));
			items.forEach(function(p){
				var b=el("button","xp-item");b.type="button";
				var img=el("img");img.src=p.avatar;img.alt="";b.appendChild(img);
				var t=el("div","xp-text");
				t.appendChild(el("div",null,p.amount+(p.shop?" at ":p.sent?" sent to ":" from ")+p.name));
				t.appendChild(el("div","xp-dim",(p.note?"\\u201c"+p.note+"\\u201d \\u00b7 ":"")+p.date));
				b.appendChild(t);
				b.onclick=function(){close();var ed=editorOf(rootOf(toolbar));if(ed)insert(ed,p.url)};
				list.appendChild(b);
			});
		},function(){loading.textContent="Couldn't load your payments."});
	}
	function buttons(){
		document.querySelectorAll('[data-testid="toolBar"]').forEach(function(toolbar){
			if(toolbar.querySelector("[data-xitter-pay]"))return;
			var emoji=toolbar.querySelector('[aria-label="Add emoji"]');
			if(!emoji)return;
			var slot=emoji;
			while(slot.parentElement&&slot.parentElement.childElementCount===1&&!slot.parentElement.matches('[data-testid="ScrollSnap-List"]'))slot=slot.parentElement;
			var copy=slot.cloneNode(true);
			var button=copy.matches('[aria-label="Add emoji"]')?copy:copy.querySelector('[aria-label="Add emoji"]');
			if(!button)return;
			button.setAttribute("aria-label","Add payment");
			button.setAttribute("data-xitter-pay","");
			button.removeAttribute("aria-haspopup");button.removeAttribute("aria-expanded");
			var svg=button.querySelector("svg");
			if(svg){svg.setAttribute("viewBox","0 0 24 24");svg.innerHTML='<g><path d="${MONEY_ICON}"></path></g>'}
			button.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();if(open)close();else show(button,toolbar)},true);
			slot.parentElement.appendChild(copy);
		});
	}

	// The composer: a payment's or request's link in the post being written
	// shows as its card under the text, as the post will, with the link itself
	// out of sight; the card's × takes the link out of the post.
	var me="";
	try{var S=window.__INITIAL_STATE__;me=S.entities.users.entities[S.session.user_id].screen_name.toLowerCase()}catch(e){}
	function linkIn(text){
		var base=location.origin+"/i/xmoney/",at=text.indexOf(base);
		var m=at<0?null:/^[pr]\\/\\d{1,19}/.exec(text.slice(at+base.length));
		return m?base+m[0]:null;
	}
	// the smallest element holding the link and nothing else, if the editor gives it one
	function linkNode(editor,url){
		return [].find.call(editor.querySelectorAll("span"),function(n){return n.textContent===url&&!(n.firstElementChild&&n.firstElementChild.textContent===url)});
	}
	function drop(editor,url){
		var n=linkNode(editor,url);
		if(!n)return;
		editor.focus();
		var range=document.createRange();range.selectNodeContents(n);
		var sel=getSelection();sel.removeAllRanges();sel.addRange(range);
		document.execCommand("delete");
	}
	function composers(){
		document.querySelectorAll('[contenteditable="true"][data-testid^="tweetTextarea_"]').forEach(function(editor){
			var root=editor;
			while(root.parentElement&&!root.parentElement.querySelector('[data-testid="toolBar"]'))root=root.parentElement;
			var shown=root.parentElement&&[].find.call(root.parentElement.children,function(c){return c.hasAttribute("data-xm-compose")});
			var url=linkIn(editor.textContent||""),key=url&&keyOf(url);
			[].forEach.call(editor.querySelectorAll("[data-xm-link]"),function(n){if(n.textContent!==url){n.removeAttribute("data-xm-link")}});
			if(!key||!root.parentElement){if(shown)shown.remove();return}
			var ck=key+"|"+me+"|preview";
			if(cache[ck]===undefined){fetchCards(me,[key],true);return}
			if(!cache[ck]){if(shown)shown.remove();return}
			var n=linkNode(editor,url);
			if(n&&!n.hasAttribute("data-xm-link"))n.setAttribute("data-xm-link","");
			if(shown&&shown.getAttribute("data-xm-compose")===key)return;
			if(shown)shown.remove();
			var box=document.createElement("div");
			box.setAttribute("data-xm-compose",key);
			box.style.setProperty("--xm-bg",bg());box.style.setProperty("--xm-fg",getComputedStyle(document.body).color);
			box.innerHTML=cache[ck];
			// a mockup: nothing in it opens or pays while writing
			[].forEach.call(box.querySelectorAll("[data-xm-go]"),function(a){a.removeAttribute("data-xm-go");a.removeAttribute("href");a.removeAttribute("tabindex")});
			var x=document.createElement("button");
			x.type="button";x.className="xm-remove";x.setAttribute("aria-label","Remove");x.textContent="\u00d7";
			x.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();drop(editor,url);box.remove()});
			box.appendChild(x);
			root.parentNode.insertBefore(box,root.nextSibling);
		});
	}

	var timer;
	function run(){timer=null;cards();if(on){pending();composers();buttons()}}
	run();
	new MutationObserver(function(){if(!timer)timer=setTimeout(run,60)}).observe(document.documentElement,{childList:true,subtree:true});
})();`;
