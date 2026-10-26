const BUTTON = ':is([data-xitter-sticker],[data-xitter-pay],[data-xitter-conversation])';
const ENABLED = `${BUTTON}:not(:disabled):not([aria-disabled="true"])`;

export const COMPOSER_BUTTON_CSS = `
[data-testid="toolBar"] [data-xitter-composer-scroll="hidden"]{visibility:hidden!important;pointer-events:none!important}
[data-testid="toolBar"] [data-xitter-composer-scroll="available"]{visibility:visible!important;opacity:1!important}
${BUTTON},${BUTTON} *{background-color:transparent!important;transform:none!important;filter:none!important}
${BUTTON}{transition:background-color .2s ease!important}
${BUTTON} svg{transition:transform .15s ease!important;transform-origin:center}
@media(hover:hover){
${ENABLED}:hover{background-color:color-mix(in srgb,currentColor 10%,transparent)!important}
${ENABLED}:hover svg{transform:scale(1.12)!important}
}
${ENABLED}:focus-visible{background-color:color-mix(in srgb,currentColor 10%,transparent)!important;outline:2px solid currentColor;outline-offset:-2px}
${ENABLED}:active{background-color:color-mix(in srgb,currentColor 20%,transparent)!important}
${ENABLED}:active svg{transform:scale(.95)!important}
@media(prefers-reduced-motion:reduce){
${BUTTON},${BUTTON} svg{transition:none!important}
${ENABLED}:is(:hover,:active) svg{transform:none!important}
}
`;

export const COMPOSER_BUTTON_SCRIPT = `(function(){
	var pending=false,observed=new WeakSet(),resize=new ResizeObserver(soon);
	function arrow(toolbar,name,available){
		var wrapper=toolbar.querySelector('[data-testid="ScrollSnap-'+name+'ButtonWrapper"]'),button;
		if(!wrapper)return;
		wrapper.setAttribute("data-xitter-composer-scroll",available?"available":"hidden");
		button=wrapper.querySelector("button");
		if(!button)return;
		if(button.disabled===available)button.disabled=!available;
		button.setAttribute("aria-disabled",String(!available));
		if(available){if(button.getAttribute("tabindex")==="-1")button.removeAttribute("tabindex")}else button.tabIndex=-1;
	}
	function update(){
		pending=false;
		document.querySelectorAll('[data-testid="toolBar"]').forEach(function(toolbar){
			var list=toolbar.querySelector('[data-testid="ScrollSnap-List"]'),offset,maximum;
			if(!list)return;
			if(!observed.has(list)){observed.add(list);resize.observe(list);list.addEventListener("scroll",soon,{passive:true})}
			offset=Math.abs(list.scrollLeft);maximum=list.scrollWidth-list.clientWidth;
			arrow(toolbar,"prev",offset>1);
			arrow(toolbar,"next",maximum-offset>1);
		});
	}
	function soon(){if(!pending){pending=true;requestAnimationFrame(update)}}
	document.addEventListener("click",function(event){
		var target=event.target.closest&&event.target.closest('[data-testid="ScrollSnap-prevButtonWrapper"],[data-testid="ScrollSnap-nextButtonWrapper"]'),toolbar=target&&target.closest('[data-testid="toolBar"]'),list=toolbar&&toolbar.querySelector('[data-testid="ScrollSnap-List"]'),direction;
		if(!list)return;
		event.preventDefault();event.stopImmediatePropagation();
		direction=target.getAttribute("data-testid")==="ScrollSnap-nextButtonWrapper"?1:-1;
		if(getComputedStyle(list).direction==="rtl")direction=-direction;
		list.scrollBy({left:direction*Math.max(36,list.clientWidth-36),behavior:matchMedia("(prefers-reduced-motion:reduce)").matches?"auto":"smooth"});
		soon();
	},true);
	new MutationObserver(soon).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["disabled"]});
	soon();
})();`;
