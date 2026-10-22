import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

// the player card converter from the pinned client build, shortened
const PLAYER = `[n.sl.PLAYER]:{conversionHandler:({cardId:e,cardType:t,converterOptions:i,data:r,users:l})=>{let d,_=(0,o.Jn)(r,"string_value","player_url"),{tweetId:p}=i,h=!s.$.isPlayerAllowlistEnabled()||(0,x.L)(_),m=p&&h?s.$.getPlayerCardIFrameUrl(p):void 0,f=[n.eu.MEDIA,n.eu.DETAILS];return(0,o.Bx)({name:t,binding_values:r})?(({cardId:e})=>{return{cardState:n.qr.DEFAULT,layout:{[n.qr.DEFAULT]:{size:"large"},[n.qr.STATIC]:{size:"small"}}}})({cardId:e}):{cardState:n.qr.DEFAULT,layout:{[n.qr.DEFAULT]:{size:"small"},[n.qr.CONDENSED]:{size:"small"},[n.qr.SECONDARY]:{size:"large"}}}}}`;

test("a player card with a frame starts as the player", () => {
	const patched = patchText(PLAYER);
	expect(patched).toContain(':{cardState:m?n.qr.SECONDARY:n.qr.DEFAULT,layout:{[n.qr.DEFAULT]:{size:"small"},[n.qr.CONDENSED]');
	// the streamed (native video) player keeps its own state
	expect(patched).toContain('return{cardState:n.qr.DEFAULT,layout:{[n.qr.DEFAULT]:{size:"large"}');
});

test("other cards keep their first state", () => {
	const other = '{cardState:n.qr.DEFAULT,layout:{[n.qr.DEFAULT]:{size:"small"},[n.qr.CONDENSED]:{size:"small"}}}';
	expect(patchText(other)).toBe(other);
});
