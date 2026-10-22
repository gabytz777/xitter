function finiteOr(v, fallback) {
	return typeof v === "number" && v === v ? v : fallback;
}

function cssUrl(path) {
	if (typeof path !== "string" || !/^\/media\/(?:poster\/)?\d{1,19}\.(?:png|gif|webp|jpg)$|^\/public\/steam\/\d{1,10}\/[0-9a-f]{40}\.(png|jpg|gif)$/.test(path)) return "none";
	return 'url("' + path + '")';
}

function bgSize(fit, scale) {
	if (fit === "tile") return scale === 100 ? "auto" : scale + "%";
	if (fit === "cover" || fit === "contain") return scale === 100 ? fit : scale + "%";
	return "auto";
}

function tileRepeat(fit, repeat) {
	if (fit !== "tile") return "no-repeat";
	if (repeat === "repeat" || repeat === "space" || repeat === "round") return repeat;
	return "repeat";
}

function bgPosition(position) {
	if (position === "top" || position === "bottom" || position === "center") return position;
	return "center";
}

function pageChromeVars(paint) {
	paint = paint || {};
	var scale = finiteOr(paint.scale, 100);
	var panel = finiteOr(paint.panel, 72);
	var dim = finiteOr(paint.dim, 0);
	var blur = finiteOr(paint.blur, 0);
	var still = paint.still ? cssUrl(paint.still) : cssUrl(paint.image);
	return {
		"--xt-bg-image": cssUrl(paint.image),
		"--xt-bg-still": still,
		"--xt-bg-size": bgSize(paint.fit, scale),
		"--xt-bg-position": bgPosition(paint.position),
		"--xt-bg-repeat": tileRepeat(paint.fit, paint.repeat),
		"--xt-bg-dim": String(dim / 100),
		"--xt-bg-blur": blur + "px",
		"--xt-bg-panel": panel + "%",
	};
}

export { pageChromeVars };
