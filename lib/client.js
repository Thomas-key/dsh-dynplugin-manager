// dsh-dynplugin-manager — client half (Settings UI).
//
// Registers a "动态插件" (Dynamic Plugins) settings section: browse plugins
// discovered from the runner managed dir + profile node_modules + legacy scan
// dirs (name, description, state badge, load command), and an install dialog
// that scans a source (local dir / GitHub repo / npm package), lets the user
// pick link/copy/managed install, runs it (modal-blocking), reports results,
// and offers an immediate mount. Data comes from the host half's same-origin
// JSON routes. Loading still happens via /dynload in a session.
window.__ModuleLoader__.load({
	id: "dsh-dynplugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const LIST_URL = "/api/dynplugin/list";
		const SCAN_URL = "/api/dynplugin/install/scan";
		const INSTALL_URL = "/api/dynplugin/install";
		const MOUNT_URL = "/api/dynplugin/mount";

		const s = {
			wrap: { width: "100%", maxWidth: "820px", display: "flex", flexDirection: "column", gap: "18px", padding: "16px" },
			sectionTitle: { margin: 0, fontSize: "14px", fontWeight: 600 },
			row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			input: { flex: 1, minWidth: 220, height: 34, boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", borderRadius: 8, padding: "0 12px", fontSize: 13 },
			select: { height: 34, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", borderRadius: 8, padding: "0 8px", fontSize: 13 },
			btn: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 8, padding: "6px 14px", fontSize: 12.5 },
			btnPrimary: { border: "none", color: "#fff", font: "inherit", cursor: "pointer", background: "#2563eb", borderRadius: 8, padding: "6px 14px", fontSize: 12.5 },
			btnDanger: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-state-error-primary, #e5534b)", font: "inherit", cursor: "pointer", background: "transparent", borderRadius: 8, padding: "4px 10px", fontSize: 12 },
			pluginCard: { border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: "6px" },
			pluginTitle: { margin: 0, fontSize: 13.5, fontWeight: 600, fontFamily: "monospace" },
			pluginDesc: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-label-secondary)", lineHeight: "1.5", wordBreak: "break-word" },
			cmd: { margin: 0, fontSize: 12, fontFamily: "monospace", color: "var(--dsw-alias-state-success-primary, #16a34a)", wordBreak: "break-all" },
			meta: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all" },
			error: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-state-error-primary, #e5534b)" },
			ok: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-state-success-primary, #16a34a)" },
			empty: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)" },
			hint: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: "1.6" },
			overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" },
			dialog: { width: "min(680px, 92vw)", maxHeight: "84vh", overflow: "auto", background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 14, padding: "18px 20px", display: "flex", flexDirection: "column", gap: "12px", boxShadow: "0 12px 40px rgba(0,0,0,0.35)" },
		};

		function badgeOf(p) {
			if (p.state === "loaded") return { text: p.channel === "loader" ? "已加载·持久" : "已加载·会话", color: "#10b981" };
			if (p.state === "idle") return { text: "未加载", color: "#3b82f6" };
			if (p.state === "failed") return { text: "加载失败", color: "#ef4444" };
			if (p.state === "needs-deps") return { text: "缺依赖声明", color: "#ef4444" };
			return { text: "未构建", color: "#f59e0b" };
		}

		function Badge(props) {
			var b = badgeOf(props.plugin);
			return react.createElement("span", { style: { fontSize: 12, color: "#fff", background: b.color, borderRadius: 10, padding: "2px 8px", whiteSpace: "nowrap" } }, b.text);
		}

		// ── install dialog ────────────────────────────────────────────────────
		function InstallDialog(props) {
			var onClose = props.onClose;
			var onInstalled = props.onInstalled;
			var [kind, setKind] = react.useState("dir");
			var [source, setSource] = react.useState("");
			var [candidates, setCandidates] = react.useState([]);
			var [scanMsg, setScanMsg] = react.useState("");
			var [scanErr, setScanErr] = react.useState("");
			var [scanning, setScanning] = react.useState(false);
			var [busy, setBusy] = react.useState("");          // installing candidate key (blocks the dialog)
			var [results, setResults] = react.useState({});    // candidate key → { ok, text }
			var [mounted, setMounted] = react.useState({});    // candidate key → mounted text

			var scan = function () {
				var src = source.trim();
				if (!src) { setScanErr("请输入来源地址"); return; }
				setScanning(true); setScanErr(""); setScanMsg(""); setCandidates([]); setResults({}); setMounted({});
				fetch(SCAN_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ source: src, kind: kind }),
				})
					.then(function (r) { return r.json(); })
					.then(function (p) {
						if (!p || p.ok !== true) throw new Error((p && p.error) || "scan failed");
						var list = p.candidates || [];
						if (list.length === 0) setScanMsg("未扫描到插件（需要 package.json + 非 bundle + 入口存在）");
						else setCandidates(list);
					})
					.catch(function (e) { setScanErr(String((e && e.message) || e)); })
					.finally(function () { setScanning(false); });
			};

			var install = function (cand, mode) {
				var key = cand.key;
				if (!key) return;
				setBusy(key); setResults(function (st) { var n = Object.assign({}, st); n[key] = { pending: true }; return n; });
				fetch(INSTALL_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ dir: cand.dir, mode: mode }),
				})
					.then(function (r) { return r.json(); })
					.then(function (p) {
						var ok = p && p.ok === true;
						var text = ok ? String((p.message) || "安装完成") : String((p && p.error) || "安装失败");
						setResults(function (st) { var n = Object.assign({}, st); n[key] = { ok: ok, text: text }; return n; });
					})
					.catch(function (e) { setResults(function (st) { var n = Object.assign({}, st); n[key] = { ok: false, text: String((e && e.message) || e) }; return n; }); })
					.finally(function () { setBusy(""); });
			};

			var mount = function (cand) {
				var key = cand.key;
				if (!key) return;
				setBusy("m:" + key);
				fetch(MOUNT_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: cand.name }),
				})
					.then(function (r) { return r.json(); })
					.then(function (p) {
						var ok = p && p.ok === true;
						var text = ok ? String((p.text) || "已挂载") : String((p && p.error) || "挂载失败");
						setMounted(function (st) { var n = Object.assign({}, st); n[key] = ok ? "✓ " + text : "✗ " + text; return n; });
					})
					.catch(function (e) { setMounted(function (st) { var n = Object.assign({}, st); n[key] = "✗ " + String((e && e.message) || e); return n; }); })
					.finally(function () { setBusy(""); });
			};

			var keyOf = function (cand, i) {
				return (cand.dir || cand.rawName || cand.name) + "#" + i;
			};

			return react.createElement("div", { style: s.overlay, onClick: function (e) { if (e.target === e.currentTarget && !busy) onClose(); } },
				react.createElement("div", { style: s.dialog },
					react.createElement("div", { style: s.row },
						react.createElement("h2", { style: Object.assign({}, s.sectionTitle, { flex: 1 }) }, "安装插件"),
						react.createElement("button", { type: "button", style: s.btn, onClick: onClose, disabled: !!busy }, "关闭")
					),
					react.createElement("div", { style: s.row },
						react.createElement("select", { style: s.select, value: kind, onChange: function (e) { setKind(e.currentTarget.value); setCandidates([]); setResults({}); setMounted({}); setScanErr(""); } },
							react.createElement("option", { value: "dir" }, "本地目录"),
							react.createElement("option", { value: "github" }, "GitHub 仓库"),
							react.createElement("option", { value: "npm" }, "npm 包")
						),
						react.createElement("input", { type: "text", style: s.input, placeholder: kind === "dir" ? "目录绝对路径，如 C:/Users/you/dsh-plugins" : (kind === "github" ? "owner/repo，如 awesome-dsh-plugin/dsh-find-plugin" : "包名，如 dsh-toolkit"), value: source, onChange: function (e) { setSource(e.currentTarget.value); } }),
						react.createElement("button", { type: "button", style: s.btnPrimary, onClick: scan, disabled: scanning || !!busy || !source.trim() }, scanning ? "扫描中…" : "扫描")
					),
					scanErr ? react.createElement("p", { style: s.error }, String(scanErr)) : null,
					scanMsg ? react.createElement("p", { style: s.empty }, String(scanMsg)) : null,

					candidates.length > 0
						? react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
							candidates.map(function (cand, i) {
								var key = keyOf(cand, i);
								cand.key = key; // mutate so install/mount can read it
								var res = results[key];
								var mountText = mounted[key];
								var isRunner = cand.channel === "runner";
								return react.createElement("div", { key: key, style: s.pluginCard },
									react.createElement("div", { style: s.row },
										react.createElement("p", { style: Object.assign({}, s.pluginTitle, { flex: 1, minWidth: 0 }) }, cand.name + (cand.version ? " (" + cand.version + ")" : "")),
										react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, isRunner ? "自包含(runner)" : "loader"),
										react.createElement("button", { type: "button", style: s.btnDanger, onClick: function () { if (!busy) install(cand, isRunner ? "managed" : "link"); }, disabled: !!busy || cand.status !== "ready" }, busy === key ? "安装中…" : (isRunner ? "安装到托管目录" : "link 安装"))
									),
									cand.description ? react.createElement("p", { style: s.pluginDesc }, String(cand.description)) : null,
									!isRunner && cand.status === "ready"
										? react.createElement("div", { style: s.row },
											react.createElement("button", { type: "button", style: s.btn, onClick: function () { if (!busy) install(cand, "copy"); }, disabled: !!busy }, busy === key ? "…" : "copy 安装（独立副本）"),
											react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, "link=改源码重启即生效；copy=独立副本，改源码需重装")
										)
										: null,
									cand.status !== "ready"
										? react.createElement("p", { style: s.error }, cand.status === "needs-deps" ? "缺依赖声明：" + (cand.imports || []).join(", ") : "未构建：请先构建（如 tsc 编译）")
										: null,
									res && res.pending ? react.createElement("p", { style: s.empty }, "安装中…（首次安装可能较慢）") : null,
									res && !res.pending
										? react.createElement("p", { style: res.ok ? s.ok : s.error, whiteSpace: "pre-wrap" }, String(res.text))
										: null,
									res && res.ok && !res.pending && !isRunner
										? react.createElement("div", { style: s.row },
											react.createElement("button", { type: "button", style: s.btnPrimary, onClick: function () { if (!busy) mount(cand); }, disabled: !!busy }, busy === "m:" + key ? "挂载中…" : "立即挂载"),
											react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, "或稍后在会话中用 /dynload 加载")
										)
										: null,
									mountText ? react.createElement("p", { style: mountText.startsWith("✓") ? s.ok : s.error }, String(mountText)) : null
								);
							})
						)
						: null,

					react.createElement("p", { style: s.hint },
						"GitHub 会先下载 zip 到缓存再扫描；npm 按单包安装（copy）。卸载：/dynunmount 停用，/dynuninstall 彻底移除（含依赖与缓存）。")
				)
			);
		}

		// ── main settings section ────────────────────────────────────────────
		function DynPluginManager() {
			const [state, setState] = react.useState({ loading: true, error: "", plugins: [] });
			const [showInstall, setShowInstall] = react.useState(false);

			const refresh = react.useCallback(function () {
				fetch(LIST_URL)
					.then(function (r) { return r.json(); })
					.then(function (p) {
						if (p && p.ok === true) setState({ loading: false, error: "", plugins: p.plugins || [] });
						else setState({ loading: false, error: (p && p.error) || "bad payload", plugins: [] });
					})
					.catch(function (e) { setState({ loading: false, error: String((e && e.message) || e), plugins: [] }); });
			}, []);

			react.useEffect(function () { refresh(); }, [refresh]);

			return react.createElement("div", { style: s.wrap },
				react.createElement("div", { style: s.row },
					react.createElement("h2", { style: Object.assign({}, s.sectionTitle, { flex: 1 }) }, "动态插件"),
					react.createElement("button", { type: "button", style: s.btnPrimary, onClick: function () { setShowInstall(true); } }, "安装插件")
				),
				react.createElement("p", { style: s.hint },
					"列表来自托管目录(runner 自包含插件) + profile 已安装的非 bundle 包 + 历史扫描目录。加载在会话中用 /dynload <插件名>（自包含→会话级，需 import→持久挂载）；/dynunmount 停用；/dynuninstall 彻底移除。"),
				state.error ? react.createElement("p", { style: s.error }, String(state.error)) : null,

				react.createElement("h3", { style: s.sectionTitle }, "插件"),
				state.loading ? react.createElement("p", { style: s.empty }, "加载中…") :
					(state.plugins.length === 0 ? react.createElement("p", { style: s.empty }, "暂无插件——点「安装插件」添加") :
						react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
							state.plugins.map(function (p) {
								return react.createElement("div", { key: p.name, style: s.pluginCard },
									react.createElement("div", { style: s.row },
										react.createElement("p", { style: Object.assign({}, s.pluginTitle, { flex: 1, minWidth: 0 }) }, p.name),
										react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap" } }, p.channel === "runner" ? "runner·会话" : (p.channel === "loader" ? "loader·持久" : "?")),
										react.createElement(Badge, { plugin: p }),
										p.dir ? react.createElement("button", { type: "button", style: s.btn, onClick: function () { window.open("file:///" + p.dir.replace(/\\/g, "/"), "_blank"); } }, "打开目录") : null
									),
									p.description ? react.createElement("p", { style: s.pluginDesc }, String(p.description)) : null,
									p.state === "failed" && p.failReason
										? react.createElement("p", { style: s.error }, "失败原因：" + String(p.failReason).slice(0, 300))
										: null,
									p.state === "needs-deps" && p.imports && p.imports.length > 0
										? react.createElement("p", { style: s.error }, "import 了但未声明： " + p.imports.join(", "))
										: null,
									react.createElement("p", { style: s.cmd }, "/dynload " + p.name),
									react.createElement("p", { style: s.meta }, (p.dir || "npm 包") + "　·　入口：" + String(p.entrySource || "?"))
								);
							})
						)
					),

				showInstall ? react.createElement(InstallDialog, {
					onClose: function () { setShowInstall(false); },
					onInstalled: refresh,
				}) : null
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			ctx.effect(() => slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "dynplugins", order: 17, label: "动态插件" },
				() => react.createElement(DynPluginManager, null)
			)), "dynplugin-manager: section");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
