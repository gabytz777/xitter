// The composer's sticker button (packs from stickers.ts). It is a copy of the
// toolbar's emoji button, so it sizes and hovers like the client's own; a
// chosen sticker goes into the composer's file input, and the client uploads
// and attaches it like any picked image.

// Material Symbols "sticker", in its own 960 unit box
const ICON = "M460-360q69 0 120-45t60-113l-320 90q26 32 62 50t78 18ZM294-510l106-30q4-28-14-49t-46-21q-25 0-42.5 17.5T280-550q0 11 4 21t10 19Zm240-70 106-30q5-28-13.5-49T580-680q-25 0-42.5 17.5T520-620q0 11 4 21t10 19Zm106 460H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v440L640-120Zm-40-80v-80q0-33 23.5-56.5T680-360h80v-400H200v560h400Zm0 0Zm-400 0v-560 560Z";

export const STICKER_PICKER_CSS = `#xitter-stickers{position:fixed;z-index:10000;width:340px;max-width:calc(100vw - 16px);max-height:min(420px,calc(100vh - 16px));display:flex;flex-direction:column;border-radius:16px;overflow:hidden;font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-shadow:rgba(101,119,134,.2) 0 0 15px,rgba(101,119,134,.15) 0 0 3px 1px}
#xitter-stickers .xs-tabs{display:flex;gap:4px;overflow-x:auto;padding:8px;border-bottom:1px solid rgba(128,128,128,.25)}
#xitter-stickers .xs-tab{flex:none;padding:6px 12px;border:0;border-radius:999px;background:none;color:inherit;font:inherit;font-size:14px;font-weight:700;cursor:pointer;opacity:.6}
#xitter-stickers .xs-tab.xs-on{opacity:1;background:var(--xt-accent-soft,rgba(29,155,240,.15));color:var(--xt-accent,#1d9bf0)}
#xitter-stickers .xs-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:8px;overflow-y:auto}
#xitter-stickers .xs-sticker{aspect-ratio:1;padding:4px;border:0;border-radius:8px;background:none;cursor:pointer}
#xitter-stickers .xs-sticker:hover{background:rgba(128,128,128,.15)}
#xitter-stickers .xs-sticker img{width:100%;height:100%;object-fit:contain}
#xitter-stickers .xs-empty{padding:24px;text-align:center;color:rgb(113,118,123);font-size:15px}`;

export const STICKER_PICKER_SCRIPT = `(function(){
	var packs=null,loading=null,open=null;
	function load(){
		if(packs)return Promise.resolve(packs);
		if(!loading)loading=fetch("/i/api/xitter/stickers",{credentials:"include"}).then(function(r){return r.ok?r.json():[]}).then(function(p){packs=p;return p},function(){loading=null;return[]});
		return loading;
	}
	function close(){if(open){open.remove();open=null}}
	document.addEventListener("keydown",function(e){if(e.key==="Escape")close()},true);
	document.addEventListener("mousedown",function(e){if(open&&!open.contains(e.target)&&!e.target.closest("[data-xitter-sticker]"))close()},true);
	// the sticker as a file in the composer's own input, as if picked from disk
	function attach(toolbar,s){
		var input=toolbar.querySelector('input[data-testid="fileInput"]');
		if(!input)return;
		fetch(s.url).then(function(r){return r.blob()}).then(function(b){
			var ext=(b.type.split("/")[1]||"png");
			var dt=new DataTransfer();
			dt.items.add(new File([b],(s.name||"sticker")+"."+ext,{type:b.type}));
			input.files=dt.files;
			input.dispatchEvent(new Event("change",{bubbles:true}));
		});
	}
	function show(button,toolbar){
		close();
		var box=document.createElement("div");
		box.id="xitter-stickers";
		var bg=getComputedStyle(document.body).backgroundColor;
		box.style.background=bg&&bg!=="rgba(0, 0, 0, 0)"?bg:"#fff";
		box.style.color=getComputedStyle(button).color;
		box.innerHTML='<div class="xs-empty">Loading…</div>';
		document.body.appendChild(box);
		open=box;
		var r=button.getBoundingClientRect();
		var top=r.bottom+6;
		if(top+420>innerHeight)top=Math.max(8,r.top-6-Math.min(420,innerHeight-16));
		box.style.top=top+"px";
		box.style.left=Math.max(8,Math.min(r.left,innerWidth-box.offsetWidth-8))+"px";
		load().then(function(p){
			if(open!==box)return;
			var withStickers=p.filter(function(x){return x.stickers.length});
			if(!withStickers.length){box.innerHTML='<div class="xs-empty">No stickers here yet.</div>';return}
			box.innerHTML='<div class="xs-tabs"></div><div class="xs-grid"></div>';
			var tabs=box.querySelector(".xs-tabs"),grid=box.querySelector(".xs-grid");
			function pick(pack){
				[].forEach.call(tabs.children,function(t){t.classList.toggle("xs-on",t.dataset.pack===pack.id)});
				grid.innerHTML="";
				pack.stickers.forEach(function(s){
					var b=document.createElement("button");
					b.type="button";b.className="xs-sticker";b.title=s.name||"";b.setAttribute("aria-label",s.name||"Sticker");
					var img=document.createElement("img");img.src=s.url;img.alt="";img.loading="lazy";
					b.appendChild(img);
					b.onclick=function(){close();attach(toolbar,s)};
					grid.appendChild(b);
				});
			}
			withStickers.forEach(function(pack){
				var t=document.createElement("button");
				t.type="button";t.className="xs-tab";t.textContent=pack.name;t.dataset.pack=pack.id;
				t.onclick=function(){pick(pack)};
				tabs.appendChild(t);
			});
			if(withStickers.length<2)tabs.remove();
			pick(withStickers[0]);
		});
	}
	function add(){
		document.querySelectorAll('[data-testid="toolBar"]').forEach(function(toolbar){
			if(toolbar.querySelector("[data-xitter-sticker]"))return;
			var emoji=toolbar.querySelector('[aria-label="Add emoji"]');
			if(!emoji)return;
			// the button's own slot in the scrolling list, copied with it
			var slot=emoji;
			while(slot.parentElement&&slot.parentElement.childElementCount===1&&!slot.parentElement.matches('[data-testid="ScrollSnap-List"]'))slot=slot.parentElement;
			var copy=slot.cloneNode(true);
			var button=copy.matches('[aria-label="Add emoji"]')?copy:copy.querySelector('[aria-label="Add emoji"]');
			if(!button)return;
			button.setAttribute("aria-label","Add sticker");
			button.setAttribute("data-xitter-sticker","");
			button.removeAttribute("aria-haspopup");
			button.removeAttribute("aria-expanded");
			var svg=button.querySelector("svg");
			if(svg){svg.setAttribute("viewBox","0 -960 960 960");svg.innerHTML='<g><path d="${ICON}"></path></g>'}
			button.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();if(open)close();else show(button,toolbar)},true);
			// last in the row: on a narrow screen the row scrolls, and an extra
			// button in the middle pushed the client's own (schedule, location) out of view
			slot.parentElement.appendChild(copy);
		});
	}
	new MutationObserver(add).observe(document.documentElement,{childList:true,subtree:true});
})();`;
