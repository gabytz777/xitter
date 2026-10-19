import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

test("profile image pickers accept GIFs without changing other pickers", () => {
	const input = [
		"{location:T.rz.Avatar,mediaItem:avatar,onChange:change}",
		"{location:T.rz.ProfileBanner,mediaItem:banner,onChange:change}",
		"{location:T.rz.Post,mediaItem:post,onChange:change}",
	].join(";");
	const patched = patchText(input);
	expect(patched).toContain("acceptGifs:!0,location:T.rz.Avatar,mediaItem:avatar");
	expect(patched).toContain("acceptGifs:!0,location:T.rz.ProfileBanner,mediaItem:banner");
	expect(patched).toContain("{location:T.rz.Post,mediaItem:post");
});

test("the Edit media cropper takes GIFs, not only images", () => {
	const patched = patchText("_getMedia=()=>{let{media:e}=this.props;return e&&e.mediaFile&&e.mediaFile.isImage?e:null}");
	expect(patched).toContain("(e.mediaFile.isImage||e.mediaFile.isGif)?e:null");
});
