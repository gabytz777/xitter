// The flag picker (pride and country flags), added under Website in the client's Edit profile
// dialog. The dialog is the client's own, so the picker is plain DOM: it reads
// the current flag from window.__XITTER__ and, when Save is pressed with a new
// choice, posts it to our account/update_flag.json. The badge lives on the
// GraphQL user the client has cached, so the page reloads once the dialog closes.

import { FLAGS, MAX_FLAGS } from "./flags";

export const flagPickerData = (flag: string | null | undefined) => ({
	flag: flag ?? "",
	flags: Object.entries(FLAGS).map(([id, f]) => ({ id, name: f.name })),
	maxFlags: MAX_FLAGS,
});

export const FLAG_PICKER_CSS = `#xitter-flags{padding:12px 0;font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#xitter-flags .xf-title{color:rgb(113,118,123);font-size:13px;margin-bottom:8px}
#xitter-flags .xf-search{box-sizing:border-box;width:100%;margin-bottom:8px;padding:8px 12px;border:1px solid rgba(128,128,128,.35);border-radius:6px;background:none;color:inherit;font:inherit;font-size:15px}
#xitter-flags .xf-list{display:flex;flex-wrap:wrap;gap:6px;max-height:210px;overflow-y:auto;padding-right:6px}
#xitter-flags .xf-list::-webkit-scrollbar{width:6px}
#xitter-flags .xf-list::-webkit-scrollbar-track{background:transparent}
#xitter-flags .xf-list::-webkit-scrollbar-thumb{background:rgba(128,128,128,.45);border-radius:999px}
#xitter-flags .xf-list::-webkit-scrollbar-thumb:hover{background:var(--xt-accent,#1d9bf0)}
@supports not selector(::-webkit-scrollbar){#xitter-flags .xf-list{scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.45) transparent}}
#xitter-flags .xf-flag[hidden]{display:none}
#xitter-flags .xf-flag{display:grid;place-items:center;width:36px;height:36px;padding:0;border:2px solid rgba(128,128,128,.35);border-radius:6px;background:none;color:rgb(113,118,123);font-size:12px;cursor:pointer}
#xitter-flags .xf-flag img{width:22px;height:22px;border-radius:3px}
#xitter-flags .xf-flag.xf-on{border-color:var(--xt-accent,#1d9bf0)}`;

export const FLAG_PICKER_SCRIPT = `(function(){
	var X=window.__XITTER__||{flag:"",flags:[],maxFlags:4};
	var saved=X.flag,chosen=saved?saved.split(","):[];
	function build(dialog){
		var url=dialog.querySelector('input[name="url"]');
		if(!url||dialog.querySelector("#xitter-flags"))return;
		chosen=saved?saved.split(","):[];
		var field=url.closest("label")||url.parentElement;
		var box=document.createElement("div");
		box.id="xitter-flags";
		box.innerHTML='<div class="xf-title">Flags next to your name, up to '+X.maxFlags+'</div><input type="search" class="xf-search" placeholder="Search flags" aria-label="Search flags"><div class="xf-list"></div>';
		var list=box.querySelector(".xf-list"),search=box.querySelector(".xf-search");
		function mark(){list.querySelectorAll(".xf-flag").forEach(function(x){var id=x.getAttribute("data-id");var on=id?chosen.indexOf(id)>=0:!chosen.length;x.classList.toggle("xf-on",on);x.setAttribute("aria-pressed",String(on))})}
		[{id:"",name:"None"}].concat(X.flags).forEach(function(f){
			var b=document.createElement("button");
			b.type="button";
			b.title=f.name;
			b.setAttribute("data-id",f.id);
			b.setAttribute("data-name",f.name.toLowerCase());
			b.setAttribute("aria-label",f.name+" flag");
			b.className="xf-flag";
			// a country's image is fetched the first time it's asked for: only the ones scrolled to
			b.innerHTML=f.id?'<img alt="" loading="lazy" src="/public/flag-'+f.id+'.svg">':"none";
			b.onclick=function(){
				var at=chosen.indexOf(f.id);
				if(!f.id)chosen=[];
				else if(at>=0)chosen.splice(at,1);
				else if(chosen.length<X.maxFlags)chosen.push(f.id);
				mark();
			};
			list.appendChild(b);
		});
		mark();
		// the Enter key would send the profile form
		search.addEventListener("keydown",function(e){if(e.key==="Enter")e.preventDefault()});
		search.addEventListener("input",function(){
			var q=search.value.trim().toLowerCase();
			list.querySelectorAll(".xf-flag").forEach(function(x){x.hidden=!!q&&x.getAttribute("data-name").indexOf(q)<0});
		});
		field.parentElement.insertBefore(box,field.nextSibling);
	}
	document.addEventListener("click",function(e){
		var save=e.target.closest&&e.target.closest('[data-testid="Profile_Save_Button"]');
		if(!save||chosen.join(",")===saved)return;
		var csrf=(document.cookie.match(/(?:^|; )ct0=([^;]+)/)||[])[1]||"";
		fetch("/i/api/1.1/account/update_flag.json",{method:"POST",credentials:"include",
			headers:{"x-csrf-token":csrf,"content-type":"application/x-www-form-urlencoded"},
			body:"flag="+encodeURIComponent(chosen.join(","))}).then(function(r){
			if(!r.ok)return;
			saved=chosen.join(",");
			var wait=setInterval(function(){
				if(document.querySelector('[role="dialog"] input[name="url"]'))return;
				clearInterval(wait);
				location.reload();
			},200);
		});
	},true);
	new MutationObserver(function(){
		var d=document.querySelector('[role="dialog"]');
		if(d)build(d);
	}).observe(document.documentElement,{childList:true,subtree:true});
})();`;
