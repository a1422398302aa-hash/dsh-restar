/**
 * dsh-restar — Browser half（重启倒计时卡片）
 *
 * 只做一件事：在输入框上方显示「DSH 还有多久重启」。
 * 数据来自宿主半注册的 /x-dsh-restar/state（读 restart.schedule.json）。
 *
 * 三条自我约束：
 *   1. 不碰现有类名、token、全局样式，全部用内联样式；
 *   2. 只在有排期时出现，其余时间完全不存在（display:none，不占位）；
 *   3. pointer-events:none —— 永远不抢点击，也不会挡住输入框。
 */
window.__ModuleLoader__.load({
	id: "dsh-restar",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		const BOX_ID = "dsh-restar-countdown";
		const ENDPOINT = "/x-dsh-restar/state";
		const POLL_MS = 500;

		const C = {
			text: "#f3e7d6",
			dim: "rgba(243,231,214,.62)",
			amber: "#f0a55c",
			red: "#ff6b5a",
			bg: "rgba(24,17,12,.92)",
			bgUrgent: "rgba(46,17,13,.94)",
			line: "rgba(240,165,92,.28)",
			lineUrgent: "rgba(255,107,90,.42)",
		};

		let box = null;
		let elTitle = null;
		let elTime = null;
		let elBarFill = null;
		let elFoot = null;
		let elCancel = null;
		let timer = null;
		let urgent = false;
		let cancelledUntil = 0;
		let visible = false;
		let hideTimer = null;
		let failStreak = 0;

		function ensureBox() {
			if (box && document.body.contains(box)) return box;
			if (!document.body) return null;

			// 热重载会重新执行 factory，但旧的 DOM 还在 —— 先清掉，避免出现两张卡片。
			const stale = document.getElementById(BOX_ID);
			if (stale && stale !== box) stale.remove();

			box = document.createElement("div");
			box.id = BOX_ID;
			box.setAttribute("data-dsh-plugin", "dsh-restar");
			box.style.cssText = [
				"position:fixed",
				"left:50%",
				"bottom:96px",
				"transform:translateX(-50%) translateY(6px)",
				"z-index:2147483001",
				"width:min(340px,calc(100vw - 40px))",
				"padding:12px 14px 10px",
				"border-radius:14px",
				"font:500 13px/1.35 ui-sans-serif,system-ui,'Segoe UI',sans-serif",
				"color:" + C.text,
				"background:" + C.bg,
				"border:1px solid " + C.line,
				"box-shadow:0 10px 34px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.05)",
				"pointer-events:none",
				"opacity:0",
				"display:none",
				"transition:opacity .22s,background .3s,border-color .3s,transform .22s",
			].join(";");

			const row = document.createElement("div");
			row.style.cssText = "display:flex;align-items:center;gap:8px";

			const dot = document.createElement("span");
			dot.setAttribute("data-role", "dot");
			dot.style.cssText = [
				"width:7px",
				"height:7px",
				"border-radius:50%",
				"background:" + C.amber,
				"box-shadow:0 0 0 3px rgba(240,165,92,.16)",
				"flex:0 0 auto",
			].join(";");

			elTitle = document.createElement("span");
			elTitle.textContent = "DS_RESTAR 即将重启";
			elTitle.style.cssText = "flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";

			elTime = document.createElement("span");
			elTime.textContent = "--:--";
			elTime.style.cssText = [
				"flex:0 0 auto",
				"font:600 20px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
				"font-variant-numeric:tabular-nums",
				"letter-spacing:.2px",
			].join(";");

			row.append(dot, elTitle, elTime);

			// 卡片上只留「还剩多久」：理由那行小字已经去掉。
			const track = document.createElement("div");
			track.style.cssText = [
				"margin:8px 0 0",
				"height:3px",
				"border-radius:2px",
				"background:rgba(255,255,255,.09)",
				"overflow:hidden",
			].join(";");

			elBarFill = document.createElement("div");
			elBarFill.style.cssText = [
				"height:100%",
				"width:0%",
				"border-radius:2px",
				"background:linear-gradient(90deg," + C.amber + ",#ffd7a8)",
				"transition:width .3s linear,background .3s",
			].join(";");
			track.appendChild(elBarFill);

			const foot = document.createElement("div");
			foot.setAttribute("data-role", "foot");
			foot.style.cssText = [
				"display:flex",
				"align-items:center",
				"gap:6px",
				"margin-top:7px",
				"font-size:10.5px",
				"line-height:1",
				"color:rgba(243,231,214,.45)",
			].join(";");

			elFoot = document.createElement("span");
			elFoot.textContent = "DS_RESTAR · 待命";
			foot.appendChild(elFoot);

			const spacer = document.createElement("span");
			spacer.style.cssText = "flex:1 1 auto";
			foot.appendChild(spacer);

			elCancel = document.createElement("button");
			elCancel.type = "button";
			elCancel.textContent = "取消重启";
			elCancel.style.cssText = [
				"pointer-events:auto",
				"cursor:pointer",
				"font:600 11px/1 ui-sans-serif,system-ui,'Segoe UI',sans-serif",
				"color:" + C.red,
				"background:rgba(255,107,90,.12)",
				"border:1px solid rgba(255,107,90,.55)",
				"border-radius:7px",
				"padding:4px 9px",
				"margin:-3px -6px -3px 0",
				"transition:background .15s,border-color .15s,color .15s",
			].join(";");
			elCancel.addEventListener("mouseenter", () => {
				elCancel.style.background = "rgba(255,107,90,.26)";
				elCancel.style.borderColor = "rgba(255,107,90,.9)";
			});
			elCancel.addEventListener("mouseleave", () => {
				elCancel.style.background = "rgba(255,107,90,.12)";
				elCancel.style.borderColor = "rgba(255,107,90,.55)";
			});
			elCancel.addEventListener("click", onCancel);
			foot.appendChild(elCancel);

			box.append(row, track, foot);
			document.body.appendChild(box);
			return box;
		}

		function fmt(ms) {
			const total = Math.max(0, Math.ceil(ms / 1000));
			const m = Math.floor(total / 60);
			const s = total % 60;
			return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
		}

		async function onCancel(event) {
			if (event) {
				event.preventDefault();
				event.stopPropagation();
			}
			if (!elCancel) return;
			elCancel.disabled = true;
			elCancel.textContent = "取消中…";
			try {
				const res = await fetch("/x-dsh-restar/cancel", { method: "POST", cache: "no-store" });
				const data = await res.json().catch(() => ({}));
				if (res.ok && data.ok) {
					cancelledUntil = Date.now() + 4000;
					paint(null);
					elCancel.textContent = "已取消";
				}
				else {
					elCancel.textContent = "取消失败";
				}
			}
			catch {
				elCancel.textContent = "取消失败";
			}
			setTimeout(() => {
				if (!elCancel) return;
				elCancel.disabled = false;
				elCancel.textContent = "取消重启";
			}, 2200);
		}

		// 显隐状态机：只在「该显示 / 该隐藏」翻转时动 DOM。
		// 之前每 500ms 都写一次 display + opacity，遇到一次 null 状态就会
		// 隐藏→显示→隐藏地抖，看起来就是整张卡片在闪。
		function showCard() {
			const b = ensureBox();
			if (!b) return;
			if (hideTimer) {
				clearTimeout(hideTimer);
				hideTimer = null;
			}
			if (visible) return;
			visible = true;
			b.dataset.on = "1";
			b.style.display = "block";
			requestAnimationFrame(() => {
				if (!box || !visible) return;
				box.style.opacity = "1";
				box.style.transform = "translateX(-50%) translateY(0)";
			});
		}

		function hideCard() {
			const b = box;
			if (!b) return;
			if (!visible) {
				if (b.style.display !== "none") b.style.display = "none";
				return;
			}
			visible = false;
			delete b.dataset.on;
			b.style.opacity = "0";
			b.style.transform = "translateX(-50%) translateY(6px)";
			if (hideTimer) clearTimeout(hideTimer);
			hideTimer = setTimeout(() => {
				hideTimer = null;
				if (box && !visible) box.style.display = "none";
			}, 240);
		}

		function setText(el, text) {
			if (el && el.textContent !== text) el.textContent = text;
		}

		function paint(state) {
			if (!state || !state.at || Date.now() < cancelledUntil) {
				hideCard();
				return;
			}
			showCard();

			const b = box;
			const left = state.at - Date.now();
			const nowUrgent = left > 0 && left <= 10000;

			if (nowUrgent !== urgent) {
				urgent = nowUrgent;
				b.style.background = urgent ? C.bgUrgent : C.bg;
				b.style.borderColor = urgent ? C.lineUrgent : C.line;
				const dot = b.querySelector('[data-role="dot"]');
				if (dot) {
					dot.style.background = urgent ? C.red : C.amber;
					dot.style.boxShadow = "0 0 0 3px " + (urgent ? "rgba(255,107,90,.18)" : "rgba(240,165,92,.16)");
				}
				elTime.style.color = urgent ? C.red : C.text;
			}

			if (left > 0) {
				setText(elTime, fmt(left));
				const span = state.requestedAt && state.at > state.requestedAt ? state.at - state.requestedAt : 0;
				const done = span > 0 ? Math.min(1, Math.max(0, 1 - left / span)) : 0;
				elBarFill.style.width = `${(done * 100).toFixed(1)}%`;
				elBarFill.style.background = urgent
					? "linear-gradient(90deg," + C.red + ",#ffb0a4)"
					: "linear-gradient(90deg," + C.amber + ",#ffd7a8)";
				setText(elTitle, "DS_RESTAR 即将重启");
				if (elFoot) {
					setText(elFoot, state.watchdog
						? `DS_RESTAR · 运行中 · pid ${state.watchdog}`
						: "DS_RESTAR · 到点自动拉起");
					elFoot.style.color = state.watchdog ? "rgba(150,220,160,.62)" : "rgba(243,231,214,.45)";
				}
			}
			else {
				setText(elTime, "0s");
				elBarFill.style.width = "100%";
				setText(elTitle, "正在重启…");
				if (elFoot) {
					setText(elFoot, "正在结束进程");
					elFoot.style.color = "rgba(255,107,90,.7)";
				}
			}
		}

		async function tick() {
			try {
				const res = await fetch(ENDPOINT, { cache: "no-store" });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				failStreak = 0;
				paint(await res.json());
			}
			catch {
				// 宿主正在重启 / 偶发失败：保持现状，别把卡片闪没；连续失败 3 秒才收起来。
				failStreak += 1;
				if (failStreak >= 6) hideCard();
			}
		}

		function apply() {
			try {
				if (!ensureBox()) {
					document.addEventListener("DOMContentLoaded", () => {
						try {
							ensureBox();
							tick();
						}
						catch (error) {
							console.warn("[dsh-restar] 卡片初始化失败", error);
						}
					}, { once: true });
				}
				if (timer) clearInterval(timer);
				timer = setInterval(tick, POLL_MS);
				tick();
			}
			catch (error) {
				console.warn("[dsh-restar] 倒计时启动失败", error);
			}
		}

		exports.name = "dsh-restar";
		exports.inject = [];
		exports.apply = apply;
		return module.exports;
	}
});
