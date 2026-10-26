import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_BUTTON_CSS, COMPOSER_BUTTON_SCRIPT } from "../src/composer-buttons";

const browserPath = process.env.BROWSER_BIN;
if (!browserPath) throw new Error("Set BROWSER_BIN to a Chromium or Edge executable.");
const profile = await mkdtemp(join(tmpdir(), "xitter-composer-buttons-"));
const port = Number(process.env.CDP_PORT ?? 9487);
const browser = Bun.spawn([browserPath, "--headless=new", "--no-sandbox", "--disable-gpu", "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
const waiting = new Map<number, (value: any) => void>();
let socket: WebSocket;
let nextId = 0;
let index: number;
let pass: number;
let current: any;

async function connect() {
	let attempt, targets, target;
	for (attempt = 0; attempt < 50; attempt++) {
		try {
			targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			target = targets.find((entry: any) => entry.type === "page");
			if (target) return new WebSocket(target.webSocketDebuggerUrl);
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("Browser did not start.");
}

function call(method: string, params: object = {}): Promise<any> {
	return new Promise<any>((resolve) => {
		const id = ++nextId;
		waiting.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	}).then((result) => {
		assert.ok(!result.error, JSON.stringify(result.error));
		return result;
	});
}

async function evaluate(expression: string) {
	const response = await call("Runtime.evaluate", { expression, returnByValue: true });
	assert.ok(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
	return response.result.value;
}

async function move(x: number, y = 25) {
	await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await Bun.sleep(250);
}

async function state(index: number) {
	return evaluate(`(function(){
		var button=document.querySelectorAll('button')[${index}],svg=button.querySelector('svg'),content=button.firstElementChild;
		return {transform:getComputedStyle(svg).transform,contentTransform:getComputedStyle(content).transform,filter:getComputedStyle(content).filter,background:getComputedStyle(button).backgroundColor,outline:getComputedStyle(button).outlineStyle,transition:getComputedStyle(svg).transitionDuration};
	})()`);
}

try {
	socket = await connect();
	await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
		if (!waiting.has(message.id)) return;
		waiting.get(message.id)!(message.result ?? { error: message.error });
		waiting.delete(message.id);
	});
	await call("Page.enable");
	await call("Page.bringToFront");
	await call("Emulation.setFocusEmulationEnabled", { enabled: true });
	await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
	await call("Page.setDocumentContent", {
		frameId: (await call("Page.getFrameTree")).frameTree.frame.id,
		html: `<style>
		body{margin:0}button{width:50px;height:50px;color:rgb(29,155,240);border:0;padding:10px}
		.frozen{transform:scale(.95) rotate(5deg);filter:brightness(3.5);background-color:rgba(29,155,240,.1)}
		${COMPOSER_BUTTON_CSS}
		</style>${["sticker", "pay", "conversation"].map((name) => `<button data-xitter-${name} class="frozen"><span class="frozen" style="transform:scale(1.07);filter:brightness(3.1)"><svg class="frozen" viewBox="0 0 24 24" width="24" height="24"><path d="M0 0h24v24H0z"/></svg></span></button>`).join("")}`,
	});
	for (index = 0; index < 3; index++) {
		await move(300);
		current = await state(index);
		assert.equal(current.transform, "none");
		assert.equal(current.contentTransform, "none");
		assert.equal(current.filter, "none");
		assert.equal(current.background, "rgba(0, 0, 0, 0)");
		await move(index * 50 + 25);
		current = await state(index);
		assert.equal(current.transform, "matrix(1.12, 0, 0, 1.12, 0, 0)");
		assert.notEqual(current.background, "rgba(0, 0, 0, 0)");
		await call("Input.dispatchMouseEvent", { type: "mousePressed", x: index * 50 + 25, y: 25, button: "left", clickCount: 1 });
		await Bun.sleep(200);
		assert.equal((await state(index)).transform, "matrix(0.95, 0, 0, 0.95, 0, 0)");
		await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: index * 50 + 25, y: 25, button: "left", clickCount: 1 });
		for (pass = 0; pass < 6; pass++) {
			await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: pass % 2 ? 300 : index * 50 + 25, y: 25 });
		}
		await move(300);
		assert.equal((await state(index)).transform, "none");
		await evaluate(`document.querySelectorAll('button')[${index}].setAttribute('aria-disabled','true')`);
		await move(index * 50 + 25);
		assert.equal((await state(index)).transform, "none");
		assert.equal((await state(index)).background, "rgba(0, 0, 0, 0)");
		await evaluate(`document.querySelectorAll('button')[${index}].removeAttribute('aria-disabled');document.querySelectorAll('button')[${index}].disabled=true`);
		assert.equal((await state(index)).transform, "none");
		await evaluate(`document.querySelectorAll('button')[${index}].disabled=false`);
	}
	await move(300);
	await evaluate("document.activeElement.blur()");
	await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
	await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
	assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), "solid");
	await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
	for (index = 0; index < 3; index++) {
		await move(index * 50 + 25);
		assert.equal((await state(index)).transform, "none");
		assert.equal((await state(index)).transition, "0s");
	}
	await evaluate('document.body.innerHTML='+JSON.stringify('<style>'+COMPOSER_BUTTON_CSS+'</style><div data-testid="toolBar"><div data-testid="ScrollSnap-prevButtonWrapper"><button>Previous</button></div><div data-testid="ScrollSnap-List" style="display:flex;overflow:auto;width:120px"><button style="flex:0 0 100px">Native</button><button data-xitter-sticker style="flex:0 0 100px">Sticker</button><button data-xitter-pay style="flex:0 0 100px">Payment</button></div><div data-testid="ScrollSnap-nextButtonWrapper"><button>Next</button></div></div>')+';'+COMPOSER_BUTTON_SCRIPT);
	await Bun.sleep(100);
	assert.equal(await evaluate("document.querySelector('[data-testid=ScrollSnap-prevButtonWrapper]').dataset.xitterComposerScroll"),"hidden");
	assert.equal(await evaluate("document.querySelector('[data-testid=ScrollSnap-nextButtonWrapper]').dataset.xitterComposerScroll"),"available");
	await evaluate("document.querySelector('[data-testid=ScrollSnap-nextButtonWrapper] button').click()");
	await Bun.sleep(100);
	assert.ok(await evaluate("document.querySelector('[data-testid=ScrollSnap-List]').scrollLeft>0"));
	for(index=0;index<5;index++)await evaluate("document.querySelector('[data-testid=ScrollSnap-nextButtonWrapper] button').click()");
	await Bun.sleep(100);
	assert.equal(await evaluate("document.querySelector('[data-testid=ScrollSnap-nextButtonWrapper]').dataset.xitterComposerScroll"),"hidden");
	assert.equal(await evaluate("document.querySelector('[data-testid=ScrollSnap-prevButtonWrapper]').dataset.xitterComposerScroll"),"available");
	await evaluate("document.querySelector('[data-testid=ScrollSnap-List]').style.width='400px'");
	await Bun.sleep(100);
	assert.equal(await evaluate("document.querySelector('[data-testid=ScrollSnap-nextButtonWrapper]').dataset.xitterComposerScroll"),"hidden");
	assert.equal(await evaluate("document.querySelector('[data-testid=ScrollSnap-prevButtonWrapper]').dataset.xitterComposerScroll"),"hidden");
	console.log("Composer buttons: animations, keyboard focus, reduced motion, scroll controls, overflow boundaries and resizing passed.");
} finally {
	socket?.close();
	browser.kill();
	await browser.exited;
	await rm(profile, { recursive: true, force: true });
}
