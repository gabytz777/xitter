// Installing the instance as an app (Add to Home Screen): the web manifest, the
// tags phones read from the page, and a script that keeps the browser chrome
// and the app icon's badge in step with the client.
//
// Push itself is push.ts. On iPhone and iPad it only works once the page is
// installed to the home screen, which is what the manifest makes possible.

import { settings } from "./settings";

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Square and opaque, with the mark inside the middle 80% so Android can cut it
// to any shape; replaceable in the admin panel (branding.ts, slot app-icon).
const ICON = "/public/app-icon.png";

export function manifest(): Response {
	const name = settings().instance_name;
	const body = {
		id: "/",
		name,
		short_name: name,
		start_url: "/home",
		scope: "/",
		display: "standalone",
		background_color: "#000000",
		theme_color: "#000000",
		icons: [
			{ src: ICON, sizes: "512x512", purpose: "any" },
			{ src: ICON, sizes: "512x512", purpose: "maskable" },
		],
		shortcuts: [
			{ name: "New post", url: "/compose/post" },
			{ name: "Notifications", url: "/notifications" },
			{ name: "Messages", url: "/i/chat" },
			{ name: "Explore", url: "/explore" },
		],
		// other apps' Share sheet: the client's post intent fills in the composer
		share_target: { action: "/intent/post", method: "GET", params: { title: "title", text: "text", url: "url" } },
	};
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
}

// for the <head> of every page that can be opened from the installed app
export const pwaHead = () => {
	const name = esc(settings().instance_name);
	return `<link rel="manifest" href="/manifest.json" /><link rel="apple-touch-icon" href="${ICON}" />
<meta name="mobile-web-app-capable" content="yes" /><meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" /><meta name="apple-mobile-web-app-title" content="${name}" />`;
};

// The client sets the page background for its theme (light, dim, dark) and puts
// the unread count in the title, "(3) Home / X". The status bar takes the
// background, and the installed app's icon takes the count.
export const PWA_SCRIPT = `(function(){
	var meta=document.querySelector('meta[name="theme-color"]'),last,count=-1;
	function sync(){
		var bg=document.body&&getComputedStyle(document.body).backgroundColor;
		if(meta&&bg&&bg!==last&&bg!=="rgba(0, 0, 0, 0)"){last=bg;meta.setAttribute("content",bg)}
		var m=/^\\((\\d+)\\+?\\)/.exec(document.title),n=m?Number(m[1]):0;
		if(n!==count&&"setAppBadge" in navigator){count=n;(n?navigator.setAppBadge(n):navigator.clearAppBadge()).catch(function(){})}
	}
	var o=new MutationObserver(sync);
	o.observe(document.documentElement,{attributes:true,attributeFilter:["style","class"]});
	o.observe(document.body,{attributes:true,attributeFilter:["style","class"]});
	o.observe(document.head,{childList:true,subtree:true,characterData:true});
	document.addEventListener("visibilitychange",sync);
	sync();
})();`;

// what the service worker shows for a page it can't reach
export const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#e7e9ea;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:center;padding:0 32px}
h1{font-size:23px;margin:0 0 8px}p{color:#71767b;margin:0 0 20px}button{padding:10px 20px;border:0;border-radius:999px;background:#eff3f4;color:#0f1419;font:inherit;font-weight:700}</style></head>
<body><div><h1>You're offline</h1><p>Check your connection and try again.</p><button onclick="location.reload()">Retry</button></div></body></html>`;
