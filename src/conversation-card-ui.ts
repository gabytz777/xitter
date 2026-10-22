export const CONVERSATION_CARD_CSS = `
@media(hover:hover){[data-xitter-conversation]:not(:disabled):not([aria-disabled="true"]):hover{background-color:color-mix(in srgb,currentColor 10%,transparent)!important}}
[data-xitter-conversation]:focus-visible{background-color:color-mix(in srgb,currentColor 10%,transparent)!important;outline:2px solid currentColor;outline-offset:-2px}
[data-xitter-conversation]:not(:disabled):not([aria-disabled="true"]):active{background-color:color-mix(in srgb,currentColor 20%,transparent)!important}
@media(prefers-reduced-motion:reduce){[data-xitter-conversation]{transition:none!important}}

.xitter-conversation{--xc-accent:rgb(29,155,240);--xc-border:rgb(207,217,222);--xc-muted:rgb(83,100,113);--xc-hover:rgba(15,20,25,.06);box-sizing:border-box;min-width:0;border:1px solid var(--xc-border);border-radius:16px;margin:12px 0;overflow:hidden;color:inherit;font:400 15px/20px TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.xitter-conversation *{box-sizing:border-box}
.xitter-conversation [hidden]{display:none!important}
.xitter-conversation .xc-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px 0}
.xitter-conversation strong{font-size:15px;font-weight:700}
.xitter-conversation .xc-description{color:var(--xc-muted);margin:4px 16px 16px;font-size:13px;line-height:16px}
.xitter-card-attachment{display:none!important}
.xitter-conversation .xc-card-preview{border:1px solid var(--xc-border);border-radius:12px;overflow:hidden}
.xitter-conversation .xc-media{position:relative;background:var(--xc-hover)}
.xitter-conversation .xc-media-empty{padding:24px 16px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
.xitter-conversation .xc-media-preview{display:block;width:100%;max-height:320px;object-fit:contain;background:rgb(0,0,0)}
.xitter-conversation .xc-media-actions{position:absolute;top:8px;right:8px;left:8px;display:flex;justify-content:space-between;gap:8px}
.xitter-conversation .xc-media-action:last-child{margin-left:auto}
.xitter-conversation .xc-media-action{border:1px solid transparent;border-radius:999px;padding:6px 12px;background:rgba(15,20,25,.85);color:rgb(255,255,255)}
.xitter-conversation .xc-thanks-preview{padding:12px 16px;border-top:1px solid var(--xc-border)}
.xitter-conversation .xc-thanks-preview p{margin:0 0 4px;font-weight:700}
.xitter-conversation .xc-thanks-preview a{color:var(--xc-accent);text-decoration:none;overflow-wrap:anywhere}
.xitter-conversation .xc-preview-tabs{display:flex;gap:8px;margin-bottom:8px}
.xitter-conversation .xc-preview-tabs button[aria-pressed=true]{background:var(--xc-hover);color:inherit}
.xitter-conversation .xc-link-fields{grid-column:1/-1;display:grid;gap:12px}
.xitter-conversation .xc-preview-title{padding:12px 16px;font-weight:700;overflow-wrap:anywhere;border-top:1px solid var(--xc-border)}
.xitter-conversation .xc-media-status{margin:4px 0 0;color:var(--xc-muted);font-size:13px;line-height:18px}
.xitter-conversation .xc-media-status[role=alert],.xitter-conversation .xc-error{color:var(--xc-error)}
.xitter-conversation .xc-error{margin:0 16px 16px;font-size:14px;line-height:20px}
.xitter-conversation .xc-media-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;border:1px solid var(--xc-border);border-radius:999px;background:var(--xc-button-bg);color:var(--xc-button-text);padding:8px 16px}
.xitter-conversation .xc-media-button:hover{opacity:.9}
.xitter-conversation .xc-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 16px 16px}
.xitter-conversation label{display:flex;flex-direction:column;min-width:0;border:1px solid var(--xc-border);border-radius:4px;padding:8px;cursor:text;transition:border-color .15s,box-shadow .15s}
.xitter-conversation label:focus-within{border-color:var(--xc-accent);box-shadow:inset 0 0 0 1px var(--xc-accent)}
.xitter-conversation label>span{color:var(--xc-muted);font-size:13px;line-height:16px}
.xitter-conversation label:focus-within>span{color:var(--xc-accent)}
.xitter-conversation .xc-hashtag-field{position:relative}
.xitter-conversation .xc-hashtag-field input{padding-left:18px}
.xitter-conversation .xc-hashtag-field>.xc-hashtag-prefix{position:absolute;left:8px;top:28px;color:inherit;font-size:15px;line-height:20px}
.xitter-conversation input,.xitter-conversation textarea{display:block;min-width:0;width:100%;border:0;border-radius:0;padding:4px 0 0;margin:0;background:transparent;color:inherit;font:inherit;outline:0;box-shadow:none}
.xitter-conversation :is(input,textarea)::placeholder{color:var(--xc-muted);opacity:1}
.xitter-conversation textarea{resize:vertical;min-height:64px}
.xitter-conversation .xc-choices{border-top:1px solid var(--xc-border)}
.xitter-conversation .xc-choice{padding:12px 16px;display:grid;gap:12px;border-bottom:1px solid var(--xc-border)}
.xitter-conversation .xc-choice-header{display:flex;align-items:center;justify-content:space-between;min-height:28px;color:var(--xc-muted);font-size:13px}
.xitter-conversation button{-webkit-tap-highlight-color:transparent;font:700 14px/20px TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;cursor:pointer;transition:background-color .15s;touch-action:manipulation}
.xitter-conversation .xc-icon-button{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;padding:6px;border:0;border-radius:50%;background:transparent;color:var(--xc-muted)}
.xitter-conversation svg{display:block;flex:none;width:20px;height:20px;fill:currentColor}
.xitter-conversation .xc-text-button{border:0;border-radius:999px;background:transparent;color:var(--xc-accent);padding:8px 12px}
.xitter-conversation button:disabled{opacity:.5;cursor:default}
.xitter-conversation button:focus-visible{outline:2px solid var(--xc-accent);outline-offset:2px}
.xitter-conversation .xc-footer{padding:4px 4px 12px}
.xitter-conversation .xc-note{margin:4px 12px 0;color:var(--xc-muted);font-size:13px;line-height:16px}
.xitter-conversation .xc-preview{padding:0 16px 16px}
.xitter-conversation .xc-preview-label{display:block;margin-bottom:8px;color:var(--xc-muted);font-size:13px;line-height:16px}
.xitter-conversation .xc-buttons{display:grid;gap:0;border-top:1px solid var(--xc-border);overflow:hidden}
.xitter-conversation .xc-pill{display:inline-flex;align-items:center;justify-content:center;min-height:36px;max-width:100%;padding:12px 16px;border:0;border-radius:0;gap:8px;color:var(--xc-accent);font-weight:700;text-decoration:none;overflow-wrap:anywhere}
.xitter-conversation .xc-pill+.xc-pill{border-top:1px solid var(--xc-border)}
@media(hover:hover){.xitter-conversation :is(.xc-icon-button,.xc-text-button):hover:not(:disabled){background:var(--xc-hover)}}
@media(max-width:480px){.xitter-conversation .xc-fields{grid-template-columns:minmax(0,1fr)}}
`;

export const CONVERSATION_CARD_SCRIPT = String.raw`(function(){
	var editors=new Map(),submission=null,preparedState=null,pendingRestore=null,timer,bootstrapCsrf=window.__XITTER__&&window.__XITTER__.csrf,cookieAtBoot=cookieCsrf(),fetchOriginal=window.fetch,xhrOpen=XMLHttpRequest.prototype.open,xhrSend=XMLHttpRequest.prototype.send,xhrHeader=XMLHttpRequest.prototype.setRequestHeader;
	function rootOf(toolbar){
		var root=toolbar.parentElement;
		while(root&&!root.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]'))root=root.parentElement;
		return root;
	}
	function mount(state){
		var root=rootOf(state.toolbar),anchor=state.toolbar;
		if(!root)return;
		while(anchor.parentElement&&anchor.parentElement!==root)anchor=anchor.parentElement;
		root.insertBefore(state.panel,anchor);
	}
	function button(text,action){
		var b=document.createElement("button");
		b.type="button";b.textContent=text;b.onclick=function(e){e.preventDefault();e.stopPropagation();action()};
		return b;
	}
	function icon(name){
		var svg=document.createElementNS("http://www.w3.org/2000/svg","svg"),path=document.createElementNS("http://www.w3.org/2000/svg","path");
		svg.setAttribute("viewBox","0 0 24 24");svg.setAttribute("width","20");svg.setAttribute("height","20");svg.setAttribute("fill","currentColor");svg.setAttribute("aria-hidden","true");
		path.setAttribute("d",name==="close"?"M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z":"M4 2h13a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H8.4L3 21V5a3 3 0 0 1 1-3zm1 2v13l2.7-2H17a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H5zm2 3h9v2H7zm0 4h6v2H7z");
		svg.appendChild(path);return svg;
	}
	function theme(panel){
		var body=getComputedStyle(document.body),rgb=body.backgroundColor.match(/\d+/g),light=!rgb||Number(rgb[0])+Number(rgb[1])+Number(rgb[2])>510,dim=!light&&Number(rgb[0])>0;
		panel.style.setProperty("--xc-border",light?"rgb(207, 217, 222)":dim?"rgb(56, 68, 77)":"rgb(47, 51, 54)");
		panel.style.setProperty("--xc-muted",light?"rgb(83, 100, 113)":"rgb(139, 152, 165)");
		panel.style.setProperty("--xc-hover",light?"rgba(15, 20, 25, .06)":"rgba(239, 243, 244, .1)");
		panel.style.setProperty("--xc-accent",light?"rgb(0, 100, 170)":"rgb(29, 155, 240)");
		panel.style.setProperty("--xc-button-bg",light?"rgb(15, 20, 25)":"rgb(239, 243, 244)");
		panel.style.setProperty("--xc-button-text",light?"rgb(255, 255, 255)":"rgb(15, 20, 25)");
		panel.style.setProperty("--xc-error",light?"rgb(184, 15, 38)":"rgb(255, 115, 128)");
		panel.style.color=light?"rgb(15, 20, 25)":"rgb(231, 233, 234)";
	}
	function field(parent,label,value,max,multiline){
		var wrap=document.createElement("label"),caption=document.createElement("span"),input=document.createElement(multiline?"textarea":"input");
		caption.textContent=label;wrap.appendChild(caption);input.value=value;input.maxLength=max;wrap.appendChild(input);parent.appendChild(wrap);
		return input;
	}
	function edit(toolbar,saved){
		var panel=document.createElement("section"),state={panel:panel,choices:[],toolbar:toolbar},header,remove,fields,title,thanks,rows,add,preview,previewButtons,footer,note,mediaBox,chooseMedia,previewCard,mediaActions,thanksUrl,thanksDisplayUrl,linkFields,tabs,cardTab,thanksTab,thanksPreview,thanksText,thanksLink;
		panel.className="xitter-conversation";panel.setAttribute("aria-label","Conversation card settings");
		header=document.createElement("div");header.className="xc-header";
		header.appendChild(document.createElement("strong")).textContent="Conversation card";
		remove=button("",function(){releaseMedia(state);panel.remove();editors.delete(state.toolbar);state.toolbar.querySelector("[data-xitter-conversation]").setAttribute("aria-expanded","false")});
		remove.className="xc-icon-button";remove.setAttribute("aria-label","Remove card");remove.title="Remove card";remove.appendChild(icon("close"));header.appendChild(remove);panel.appendChild(header);
		note=document.createElement("p");note.className="xc-description";note.textContent="Choose one image, GIF or video and up to four hashtag buttons.";panel.appendChild(note);
		preview=document.createElement("div");preview.className="xc-preview";preview.setAttribute("aria-live","polite");
		note=document.createElement("span");note.className="xc-preview-label";note.textContent="Card preview";preview.appendChild(note);
		tabs=document.createElement("div");tabs.className="xc-preview-tabs";preview.appendChild(tabs);
		cardTab=button("Before posting",function(){state.thankYouPreview=false;update()});cardTab.className="xc-text-button";tabs.appendChild(cardTab);
		thanksTab=button("After posting",function(){state.thankYouPreview=true;update()});thanksTab.className="xc-text-button";tabs.appendChild(thanksTab);
		previewCard=document.createElement("div");previewCard.className="xc-card-preview";preview.appendChild(previewCard);
		mediaBox=document.createElement("div");mediaBox.className="xc-media";previewCard.appendChild(mediaBox);
		state.mediaEmpty=document.createElement("div");state.mediaEmpty.className="xc-media-empty";mediaBox.appendChild(state.mediaEmpty);
		chooseMedia=button("Add image or video",function(){
			var input=state.toolbar.querySelector('input[data-testid="fileInput"]');
			if(input)input.click();
		});chooseMedia.className="xc-media-button";state.mediaEmpty.appendChild(chooseMedia);
		state.mediaStatus=document.createElement("p");state.mediaStatus.className="xc-media-status";state.mediaStatus.textContent="One image, GIF or video. Post text is optional.";state.mediaEmpty.appendChild(state.mediaStatus);
		state.mediaPreview=document.createElement("div");mediaBox.appendChild(state.mediaPreview);
		mediaActions=document.createElement("div");mediaActions.className="xc-media-actions";mediaActions.hidden=true;mediaBox.appendChild(mediaActions);state.mediaActions=mediaActions;
		state.editMedia=button("Crop image",function(){
			var action=state.attachment&&state.attachment.querySelector('[aria-label="Edit media"],[data-testid="altTextWrapper"]');
			if(action)action.click();
		});state.editMedia.className="xc-media-action";mediaActions.appendChild(state.editMedia);
		state.removeMedia=button("Remove media",function(){
			var action=state.attachment&&state.attachment.querySelector('[aria-label="Remove media"]');
			if(action)action.click();
		});state.removeMedia.className="xc-media-action";mediaActions.appendChild(state.removeMedia);
		state.previewTitle=document.createElement("div");state.previewTitle.className="xc-preview-title";state.previewTitle.hidden=true;previewCard.appendChild(state.previewTitle);
		previewButtons=document.createElement("div");previewButtons.className="xc-buttons";previewCard.appendChild(previewButtons);
		thanksPreview=document.createElement("div");thanksPreview.className="xc-thanks-preview";thanksPreview.hidden=true;previewCard.appendChild(thanksPreview);
		thanksText=document.createElement("p");thanksPreview.appendChild(thanksText);
		thanksLink=document.createElement("a");thanksLink.target="_blank";thanksLink.rel="noopener noreferrer";thanksPreview.appendChild(thanksLink);panel.appendChild(preview);
		state.error=document.createElement("p");state.error.className="xc-error";state.error.setAttribute("role","alert");state.error.hidden=true;panel.appendChild(state.error);
		fields=document.createElement("div");fields.className="xc-fields";panel.appendChild(fields);
		title=field(fields,"Title (optional)","",23,false);
		thanks=field(fields,"Thank-you message (optional)","",23,false);
		linkFields=document.createElement("div");linkFields.className="xc-link-fields";fields.appendChild(linkFields);
		thanksUrl=field(linkFields,"Thank-you URL (optional)","",2048,false);thanksUrl.type="url";thanksUrl.placeholder="https://example.com/learn-more";
		thanksDisplayUrl=field(linkFields,"Display URL (optional)","",100,false);thanksDisplayUrl.placeholder="example.com/learn-more";
		rows=document.createElement("div");rows.className="xc-choices";panel.appendChild(rows);
		function update(){
			var destination;
			cardTab.setAttribute("aria-pressed",String(!state.thankYouPreview));thanksTab.setAttribute("aria-pressed",String(!!state.thankYouPreview));
			thanksPreview.hidden=!state.thankYouPreview;previewButtons.hidden=!!state.thankYouPreview;
			thanksText.textContent=thanks.value.trim()||"Thanks for joining!";
			thanksLink.hidden=true;thanksLink.removeAttribute("href");
			try{destination=new URL(thanksUrl.value.trim());if(/^https?:$/.test(destination.protocol)&&!destination.username&&!destination.password){thanksLink.href=destination.href;thanksLink.textContent=thanksDisplayUrl.value.trim()||destination.href;thanksLink.hidden=false}}catch(e){}
			state.previewTitle.hidden=!!state.thankYouPreview||!title.value.trim();if(state.previewTitle.textContent!==title.value.trim())state.previewTitle.textContent=title.value.trim();
			add.disabled=state.choices.length>=4;previewButtons.replaceChildren();
			state.choices.forEach(function(c,i){
				var pill=document.createElement("span");
				pill.className="xc-pill";pill.appendChild(icon("card"));pill.appendChild(document.createTextNode("Post "+hashtag(c.hashtag.value||"Hashtag")));previewButtons.appendChild(pill);
				c.caption.textContent="Hashtag "+(i+1);c.remove.disabled=state.choices.length===1;
			});
		}
		function choice(){
			var row=document.createElement("div"),item={row:row},heading=document.createElement("div"),remove;
			row.className="xc-choice";heading.className="xc-choice-header";item.caption=document.createElement("span");heading.appendChild(item.caption);
			remove=button("",function(){if(state.choices.length===1)return;state.choices=state.choices.filter(function(c){return c!==item});row.remove();update()});
			remove.className="xc-icon-button";remove.setAttribute("aria-label","Remove hashtag");remove.title="Remove hashtag";remove.appendChild(icon("close"));item.remove=remove;heading.appendChild(remove);row.appendChild(heading);
			item.hashtag=field(row,"Hashtag","",20,false);item.hashtag.placeholder="YourHashtag";item.hashtag.parentElement.classList.add("xc-hashtag-field");
			item.prefix=document.createElement("span");item.prefix.className="xc-hashtag-prefix";item.prefix.textContent="#";item.prefix.setAttribute("aria-hidden","true");item.hashtag.before(item.prefix);
			item.text=field(row,"Prefilled post text (optional)","",256,true);item.text.placeholder="Leave blank to post just the hashtag";
			item.hashtag.oninput=function(){item.hashtag.value=item.hashtag.value.replace(/^#+/,"").slice(0,19);update()};
			state.choices.push(item);rows.appendChild(row);update();
		}
		footer=document.createElement("div");footer.className="xc-footer";
		add=button("Add hashtag",choice);add.className="xc-text-button";footer.appendChild(add);
		note=document.createElement("p");note.className="xc-note";note.textContent="Save as a draft or choose a posting time using the composer controls.";footer.appendChild(note);panel.appendChild(footer);
		title.oninput=update;thanks.oninput=update;thanksUrl.oninput=update;thanksDisplayUrl.oninput=update;state.title=title;state.thanks=thanks;state.thanksUrl=thanksUrl;state.thanksDisplayUrl=thanksDisplayUrl;state.editor=rootOf(toolbar).querySelector('[contenteditable="true"]');
		theme(panel);editors.set(toolbar,state);mount(state);toolbar.querySelector("[data-xitter-conversation]").setAttribute("aria-expanded","true");choice();
		if(saved){
			title.value=saved.title||"";thanks.value=saved.thanks||"";thanksUrl.value=saved.thanksUrl||"";thanksDisplayUrl.value=saved.thanksDisplayUrl||"";
			while(state.choices.length<saved.choices.length)choice();
			saved.choices.forEach(function(item,index){state.choices[index].hashtag.value=(item.hashtag||"").replace(/^#+/,"");state.choices[index].text.value=item.text||""});update();
		}
		syncMedia(state);
	}
	function releaseMedia(state){
		if(state.attachment)state.attachment.classList.remove("xitter-card-attachment");
	}
	function syncMedia(state){
		var root=rootOf(state.toolbar),attachment=root&&root.querySelector('[data-testid="attachments"]'),source=attachment&&(attachment.querySelector("video")||attachment.querySelector("img")),count=attachment&&attachment.querySelectorAll('[aria-label="Remove media"]').length,video=source&&source.tagName.toLowerCase()==="video",url=source&&(source.getAttribute("src")||source.currentSrc||(source.querySelector("source")&&source.querySelector("source").getAttribute("src"))),poster=video&&source.getAttribute("poster"),key=source&&JSON.stringify([video,url,poster]),preview,message,label,edit=attachment&&attachment.querySelector('[aria-label="Edit media"]'),description=attachment&&attachment.querySelector('[data-testid="altTextWrapper"]'),visible=!!source&&!!url&&count===1;
		if(state.attachment!==attachment){releaseMedia(state);state.attachment=attachment}
		if(attachment)attachment.classList.toggle("xitter-card-attachment",visible&&!state.panel.hidden);
		state.mediaEmpty.hidden=visible;state.mediaActions.hidden=!visible;state.editMedia.hidden=!edit&&!description;
		label=edit?(video?"Edit video":"Crop image"):"Edit description";if(state.editMedia.textContent!==label)state.editMedia.textContent=label;
		message=count>1?"Keep exactly one image, GIF or video using the attachment controls above.":"One image, GIF or video. Post text is optional.";
		if(state.mediaStatus.textContent!==message)state.mediaStatus.textContent=message;
		if(count>1)state.mediaStatus.setAttribute("role","alert");else state.mediaStatus.removeAttribute("role");
		if(!visible)key=null;
		if(state.mediaKey===key)return;
		state.mediaKey=key;state.mediaPreview.replaceChildren();
		if(!visible)return;
		preview=document.createElement(video?"video":"img");preview.className="xc-media-preview";preview.src=url;
		if(video){preview.controls=true;preview.muted=true;preview.playsInline=true;if(poster)preview.poster=poster}else preview.alt="Conversation card attachment";
		state.mediaPreview.appendChild(preview);
	}
	function hashtag(value){return "#"+(value.trim().replace(/^#+/,""))}
	function settings(state){
		var result={title:state.title.value.trim(),thanks:state.thanks.value.trim()},url=state.thanksUrl.value.trim(),display=state.thanksDisplayUrl.value.trim();
		if(url){try{url=new URL(url).href}catch(e){}result.thanksUrl=url}if(display)result.thanksDisplayUrl=display;
		result.choices=state.choices.map(function(c){return {hashtag:hashtag(c.hashtag.value),text:c.text.value.trim()}});
		return result;
	}
	function composerToolbars(){
		var dialogs=document.querySelectorAll('[role="dialog"]'),index,toolbars;
		for(index=dialogs.length-1;index>=0;index--){toolbars=dialogs[index].querySelectorAll('[data-testid="toolBar"]');if(toolbars.length)return Array.from(toolbars)}
		if(/^\/compose\/(?:post|tweet)(?:\/|$)/.test(location.pathname||""))return [];
		return Array.from(document.querySelectorAll('[data-testid="toolBar"]'));
	}
	function captureSubview(target){
		var part,parts,selected=target.closest('[data-testid="scheduleOption"],[data-testid="scheduledTweetIndicator"],[aria-label="Edit media"],[data-testid="altTextWrapper"],.xc-media-actions button:first-child');
		if(!selected)return;
		parts=composerToolbars().map(function(toolbar){
			var root=rootOf(toolbar),editor=root&&root.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]'),state=editors.get(toolbar),part={status:editor?String(editor.innerText||editor.textContent||""):""};
			if(state)part.xitter_conversation_card=settings(state);
			return part;
		});
		if(!parts.some(function(part){return !!part.xitter_conversation_card}))return;
		part=parts[0];part.thread_tweets=parts.slice(1);
		pendingRestore={request:part,applied:new Set(),origin:location.pathname,waitForReturn:true,departed:false};
	}
	document.addEventListener("pointerdown",function(event){captureSubview(event.target)},true);
	document.addEventListener("click",function(event){captureSubview(event.target)},true);
	function restoreSaved(){
		var toolbars,parts,remaining=false;
		if(!pendingRestore)return;
		if(pendingRestore.waitForReturn&&!pendingRestore.departed){
			if(location.pathname===pendingRestore.origin)return;
			pendingRestore.departed=true;
		}
		if(!/\/compose\/(?:post|tweet)$/.test(location.pathname||"")&&location.pathname!==pendingRestore.origin)return;
		toolbars=composerToolbars();parts=[pendingRestore.request].concat(pendingRestore.request.thread_tweets||[]);
		parts.forEach(function(part,index){
			var toolbar=toolbars[index],root=toolbar&&rootOf(toolbar),editor=root&&root.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]'),state=toolbar&&editors.get(toolbar);
			if(editor&&pendingRestore.applied.has(editor))return;
			if(!editor||String(editor.innerText||editor.textContent||"").trim()!==String(part.status||"").trim()){remaining=true;return}
			if(state){releaseMedia(state);state.panel.remove();editors.delete(toolbar);toolbar.querySelector('[data-xitter-conversation]').setAttribute('aria-expanded','false')}
			if(part.xitter_conversation_card)edit(toolbar,part.xitter_conversation_card);
			pendingRestore.applied.add(editor);
		});
		if(!remaining)pendingRestore=null;
	}
	document.addEventListener("xitter:restore-conversation-cards",function(event){
		if(!event.detail||typeof event.detail!=="object")return;
		pendingRestore={request:event.detail,applied:new Set()};soon();
	});
	window.__XITTER_CONVERSATION_DRAFT_LABEL__=function(card){return card.title||(card.choices||[]).map(function(choice){return choice.hashtag}).filter(Boolean).join(" ")||"Conversation card"};
	window.__XITTER_CONVERSATION_HAS_DRAFT__=function(){return composerToolbars().some(function(toolbar){return editors.has(toolbar)})};
	function submitting(target){
		var ancestor=target,toolbar,state;
		draw();
		while(ancestor&&!(ancestor.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]')&&ancestor.querySelector('[data-testid="toolBar"]')))ancestor=ancestor.parentElement;
		toolbar=target.closest('[data-testid="toolBar"]')||(ancestor&&ancestor.querySelector('[data-testid="toolBar"]'));
		state=toolbar&&editors.get(toolbar);
		submission={state:state||null};
	}
	document.addEventListener("pointerdown",function(e){if(e.target.closest('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]'))submitting(e.target)},true);
	document.addEventListener("click",function(e){if(e.target.closest('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]'))submitting(e.target)},true);
	document.addEventListener("keydown",function(e){if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)&&e.target.closest('[contenteditable="true"]'))submitting(e.target)},true);
	function prepare(url,body){
		var data,vars,matches=[],entry,encoded,unsentParts,toolbars;
		preparedState=null;
		if(!/\/graphql\//.test(url)||typeof body!=="string")return body;
		try{data=JSON.parse(body)}catch(e){return body}
		encoded=typeof data.variables==="string";
		try{vars=encoded?JSON.parse(data.variables):data.variables}catch(e){return body}
		if(!vars)return body;
		draw();
		if(/(?:Create|Edit|Update)(?:Scheduled|Draft)/.test(url)&&vars.post_tweet_request){
			unsentParts=[vars.post_tweet_request].concat(vars.post_tweet_request.thread_tweets||[]);toolbars=composerToolbars();
			unsentParts.forEach(function(part,index){
				var toolbar=toolbars[index],state=toolbar&&editors.get(toolbar),root=toolbar&&rootOf(toolbar),editor=root&&root.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]');
				if(state&&editor&&String(editor.innerText||editor.textContent||"").trim()===String(part.status||"").trim()){part.xitter_conversation_card=settings(state);if(!preparedState)preparedState=state}
			});
		}
		editors.forEach(function(state,toolbar){
			var root,editor;
			if(!toolbar.isConnected){editors.delete(toolbar);return}
			root=rootOf(toolbar);editor=root&&root.querySelector('[contenteditable="true"][data-testid^="tweetTextarea_"]');
			if(editor&&String(editor.innerText||editor.textContent||"").trim()===String(vars.tweet_text||"").trim())matches.push(state);
		});
		if(/\/CreateTweet(?:\?|$)/.test(url)&&submission){
			if(submission.state&&submission.state.panel.isConnected){preparedState=submission.state;vars.xitter_conversation_card=settings(preparedState)}
		}else if(/\/CreateTweet(?:\?|$)/.test(url)&&matches.length===1){
			entry=matches[0];preparedState=entry;vars.xitter_conversation_card=settings(entry);
		}
		if(/\/CreateTweet(?:\?|$)/.test(url)&&!submission&&matches.length>1)vars.xitter_conversation_card=null;
		if(vars.xitter_conversation_card&&Array.isArray(vars.media&&vars.media.media_entities)&&vars.media.media_entities.length!==1&&submission&&submission.state){
			submission.state.mediaStatus.textContent="Add exactly one image or video before posting this card.";submission.state.mediaStatus.setAttribute("role","alert");
		}
		if(preparedState)preparedState.error.hidden=true;
		if(encoded)data.variables=JSON.stringify(vars);
		return JSON.stringify(data);
	}
	function received(data,state){
		var result=data&&data.data&&data.data.create_tweet&&data.data.create_tweet.tweet_results&&data.data.create_tweet.tweet_results.result;
		if(state&&data&&Array.isArray(data.errors)&&data.errors.length){
			state.error.textContent=data.errors.map(function(error){return String(error.message||"Could not publish this conversation card.").replace(/^Error:\s*/,"")}).join(" ");state.error.hidden=false;state.panel.hidden=false;
		}
		if(result&&result.xitter_conversation_card)editors.forEach(function(state,toolbar){if(JSON.stringify(settings(state))===JSON.stringify(result.xitter_conversation_card)){releaseMedia(state);state.panel.remove();editors.delete(toolbar);toolbar.querySelector("[data-xitter-conversation]").setAttribute("aria-expanded","false")}});
		if(result)submission=null;
		soon();
	}
	function localApi(url){
		var parsed;
		try{parsed=new URL(url,location.origin)}catch(e){return false}
		return parsed.origin===location.origin&&/^\/(?:i\/(?:jf)?api\/|i\/media\/|1\.1\/|2\/|graphql\/|v2\/(?:cards|capi)\/|cards\/)/.test(parsed.pathname);
	}
	function cookieCsrf(){return(String(document.cookie||"").match(/(?:^|;\s*)ct0=([^;]+)/)||[])[1]||""}
	function csrf(){
		var current=cookieCsrf();
		return bootstrapCsrf&&current===cookieAtBoot?bootstrapCsrf:current;
	}
	window.fetch=async function(input,init){
		var url=input instanceof Request?input.url:String(input),options=init,response,body,request,headers,token,state;
		if(localApi(url)){
			if(input instanceof Request){
				request=new Request(input,init);headers=new Headers(request.headers);
				if(request.method!=="GET"&&request.method!=="HEAD")body=prepare(url,await request.clone().text());
				options={headers:headers,credentials:request.credentials};if(body!==undefined)options.body=body;input=request;
			}else{
				headers=new Headers(init&&init.headers);options=Object.assign({},init,{headers:headers});
				if(init&&typeof init.body==="string")options.body=prepare(url,init.body);
			}
			token=csrf();if(token)headers.set("x-csrf-token",token);
		}
		state=localApi(url)&&/(?:CreateTweet|(?:Create|Edit|Update)(?:Scheduled|Draft)Tweet)(?:\?|$)/.test(url)?preparedState:null;
		response=await fetchOriginal.call(this,input,options);
		if(localApi(url)&&/\/graphql\//.test(url))response.clone().json().then(function(data){received(data,state)},function(){});
		return response;
	};
	XMLHttpRequest.prototype.open=function(method,url){
		this.xitterConversationUrl=String(url);this.xitterConversationCsrf=null;
		return xhrOpen.apply(this,arguments);
	};
	XMLHttpRequest.prototype.setRequestHeader=function(name,value){
		if(localApi(this.xitterConversationUrl||"")&&name.toLowerCase()==="x-csrf-token"){
			this.xitterConversationCsrf=String(value);return;
		}
		return xhrHeader.call(this,name,value);
	};
	XMLHttpRequest.prototype.send=function(body){
		var xhr=this,url=xhr.xitterConversationUrl||"",token,state;
		if(localApi(url)){
			if(/\/graphql\//.test(url))xhr.addEventListener("load",function(){try{received(xhr.responseType==="json"?xhr.response:JSON.parse(xhr.responseText),state)}catch(e){}});
			body=prepare(url,body);state=preparedState;token=csrf()||xhr.xitterConversationCsrf;if(token)xhrHeader.call(xhr,"x-csrf-token",token);
		}
		return xhrSend.call(xhr,body);
	};
	function draw(){
		document.querySelectorAll('[data-testid="toolBar"]').forEach(function(toolbar){
			var emoji,slot,copy,b,svg,state=editors.get(toolbar),source=rootOf(toolbar),editor=source&&source.querySelector('[contenteditable="true"]');
			if(!state&&editor)editors.forEach(function(entry,previous){if(!previous.isConnected&&entry.editor===editor){editors.delete(previous);editors.set(toolbar,entry);entry.toolbar=toolbar;state=entry}});
			if(state&&!state.panel.isConnected)mount(state);
			if(state&&source){theme(state.panel);syncMedia(state)}
			if(toolbar.querySelector("[data-xitter-conversation]")||!source)return;
			emoji=toolbar.querySelector('[aria-label="Add emoji"]');if(!emoji)return;
			slot=emoji;
			while(slot.parentElement&&slot.parentElement.childElementCount===1&&!slot.parentElement.matches('[data-testid="ScrollSnap-List"]')&&slot.parentElement!==toolbar)slot=slot.parentElement;
			copy=slot.cloneNode(true);b=copy.matches('[aria-label="Add emoji"]')?copy:copy.querySelector('[aria-label="Add emoji"]');if(!b)return;
			b.setAttribute("data-xitter-conversation","");b.setAttribute("data-testid","conversationCardButton");b.setAttribute("aria-label","Add conversation card");b.setAttribute("aria-expanded","false");b.title="Conversation card";
			b.removeAttribute("aria-haspopup");b.removeAttribute("aria-describedby");b.removeAttribute("aria-controls");b.removeAttribute("id");
			svg=b.querySelector("svg");if(svg){svg.setAttribute("viewBox","0 0 24 24");svg.replaceChildren(icon("card").firstChild)}else b.appendChild(icon("card"));
			b.addEventListener("click",function(e){
				var state=editors.get(toolbar);
				e.preventDefault();e.stopPropagation();
				if(state){state.panel.hidden=!state.panel.hidden;syncMedia(state);b.setAttribute("aria-expanded",String(!state.panel.hidden))}else edit(toolbar);
			},true);
			slot.parentElement.insertBefore(copy,slot);
		});
		restoreSaved();
		editors.forEach(function(state,toolbar){if(!toolbar.isConnected&&!state.editor.isConnected){releaseMedia(state);editors.delete(toolbar)}});
	}
	function soon(){if(!timer)timer=setTimeout(function(){timer=null;draw()},100)}
	new MutationObserver(soon).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src","poster"]});
	new MutationObserver(soon).observe(document.body,{attributes:true,attributeFilter:["style","class"]});soon();
})();`;
