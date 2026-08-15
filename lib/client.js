// dsh-dynplugin-manager — client half (Settings UI).
//
// Registers a "动态插件" (Dynamic Plugins) settings section: manage scan
// directories (add with optional alias, delete) and browse scanned plugins
// (name, description, README, open-source-directory, load command). Data
// comes from the host half's same-origin JSON routes. Read-only for plugins:
// loading happens via the /dynload slash command in a session.
window.__ModuleLoader__.load({
	id: "dsh-dynplugin-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const LIST_URL = "/api/dynplugin/list";
		const DIRS_URL = "/api/dynplugin/dirs";
		const DIR_URL = "/api/dynplugin/dir";

		const s = {
			wrap: { width: "100%", maxWidth: "820px", display: "flex", flexDirection: "column", gap: "18px", padding: "16px" },
			sectionTitle: { margin: 0, fontSize: "14px", fontWeight: 600 },
			sub: { margin: 0, fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary)", lineHeight: "1.6" },
			row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			input: { flex: 1, minWidth: 220, height: 34, boxSizing: "border-box", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", borderRadius: 8, padding: "0 12px", fontSize: 13 },
			btn: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", background: "var(--dsw-alias-bg-layer-1)", borderRadius: 8, padding: "6px 14px", fontSize: 12.5 },
			btnDanger: { border: "1px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-state-error-primary, #e5534b)", font: "inherit", cursor: "pointer", background: "transparent", borderRadius: 8, padding: "4px 10px", fontSize: 12 },
			dirCard: { border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 10, padding: "10px 12px" },
			dirName: { margin: 0, fontSize: 13, fontWeight: 600, wordBreak: "break-all" },
			dirMeta: { margin: "3px 0 0", fontSize: 12, color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all" },
			pluginCard: { border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: "6px" },
			pluginTitle: { margin: 0, fontSize: 13.5, fontWeight: 600, fontFamily: "monospace" },
			pluginDesc: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-label-secondary)", lineHeight: "1.5", wordBreak: "break-word" },
			pluginReadme: { margin: 0, fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)", lineHeight: "1.5", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 120, overflow: "hidden" },
			cmd: { margin: 0, fontSize: 12, fontFamily: "monospace", color: "var(--dsw-alias-state-success-primary, #16a34a)", wordBreak: "break-all" },
			meta: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all" },
			error: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-state-error-primary, #e5534b)" },
			empty: { margin: 0, fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)" },
			hint: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: "1.6" },
		};

		function DynPluginManager() {
			const [state, setState] = react.useState({ loading: true, error: "", plugins: [], dirs: [] });
			const [newPath, setNewPath] = react.useState("");
			const [newAlias, setNewAlias] = react.useState("");
			const [busy, setBusy] = react.useState("");

			const refresh = react.useCallback(function () {
				setState(function (st) { return { loading: true, error: "", plugins: st.plugins, dirs: st.dirs }; });
				fetch(LIST_URL)
					.then(function (r) { return r.json(); })
					.then(function (p) {
						if (p && p.ok === true) setState({ loading: false, error: "", plugins: p.plugins || [], dirs: p.dirs || [] });
						else setState({ loading: false, error: (p && p.error) || "bad payload", plugins: [], dirs: [] });
					})
					.catch(function (e) { setState({ loading: false, error: String((e && e.message) || e), plugins: [], dirs: [] }); });
			}, []);

			react.useEffect(function () { refresh(); }, [refresh]);

			const addDir = function () {
				const path = newPath.trim();
				if (!path) return;
				setBusy("add");
				fetch(DIRS_URL, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: path, alias: newAlias.trim() }),
				})
					.then(function (r) { return r.json(); })
					.then(function (p) {
						if (!p || p.ok !== true) throw new Error((p && p.error) || "add failed");
						setNewPath("");
						setNewAlias("");
						refresh();
					})
					.catch(function (e) { setState(function (st) { return { loading: false, error: String((e && e.message) || e), plugins: st.plugins, dirs: st.dirs }; }); })
					.finally(function () { setBusy(""); });
			};

			const removeDir = function (path) {
				setBusy("rm:" + path);
				fetch(DIR_URL, {
					method: "DELETE",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: path }),
				})
					.then(function (r) { return r.json(); })
					.then(function (p) {
						if (!p || p.ok !== true) throw new Error((p && p.error) || "remove failed");
						refresh();
					})
					.catch(function (e) { setState(function (st) { return { loading: false, error: String((e && e.message) || e), plugins: st.plugins, dirs: st.dirs }; }); })
					.finally(function () { setBusy(""); });
			};

			return react.createElement("div", { style: s.wrap },
				react.createElement("h2", { style: s.sectionTitle }, "动态插件"),
				react.createElement("p", { style: s.hint },
					"扫描指定目录下每个第一层子文件夹：含 package.json 且无 dsh.bundle 声明的列为插件；入口按 dsh.dynamic.host → main → exports → index.js 推断，文件不存在标「未构建」。此页只读浏览；加载在会话中用 /dynload <插件名>（自动分流：自包含→会话级，需 import→持久挂载），卸载用 /dynunmount <插件名>。"),
				state.error ? react.createElement("p", { style: s.error }, String(state.error)) : null,

				// ── scan directory management ──
				react.createElement("h3", { style: s.sectionTitle }, "扫描目录"),
				react.createElement("div", { style: s.row },
					react.createElement("input", { type: "text", style: s.input, placeholder: "目录绝对路径，如 C:/Users/you/dsh-plugins", value: newPath, onChange: function (e) { setNewPath(e.currentTarget.value); } }),
					react.createElement("input", { type: "text", style: Object.assign({}, s.input, { minWidth: 120, flex: "0 1 160px" }), placeholder: "别名（可选，唯一）", value: newAlias, onChange: function (e) { setNewAlias(e.currentTarget.value); } }),
					react.createElement("button", { type: "button", style: s.btn, onClick: addDir, disabled: busy === "add" || !newPath.trim() }, busy === "add" ? "添加中…" : "添加目录")
				),
				state.loading ? react.createElement("p", { style: s.empty }, "加载中…") :
					(state.dirs.length === 0 ? react.createElement("p", { style: s.empty }, "尚未添加扫描目录") :
						react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
							state.dirs.map(function (d) {
								return react.createElement("div", { key: d.path, style: s.dirCard },
									react.createElement("div", { style: s.row },
										react.createElement("div", { style: { flex: 1, minWidth: 0 } },
											react.createElement("p", { style: s.dirName }, d.alias ? d.alias + "（" + d.path + "）" : d.path),
											react.createElement("p", { style: s.dirMeta }, "扫描到 " + d.count + " 个插件")
										),
										react.createElement("button", { type: "button", style: s.btnDanger, onClick: function () { removeDir(d.path); }, disabled: busy === "rm:" + d.path }, busy === "rm:" + d.path ? "…" : "移除")
									)
								);
							})
						)
					),

				// ── plugin list ──
				react.createElement("h3", { style: s.sectionTitle }, "已扫描插件"),
				state.loading ? react.createElement("p", { style: s.empty }, "加载中…") :
					(state.plugins.length === 0 ? react.createElement("p", { style: s.empty }, "暂无插件（确认目录下有含 package.json 且非 bundle 的子文件夹）") :
						react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
							state.plugins.map(function (p) {
								var badge = p.status === "ready"
									? (p.channel === "loader" ? { text: "loader·持久", color: "#8b5cf6" } : { text: "runner·会话", color: "#10b981" })
									: (p.status === "needs-deps" ? { text: "缺依赖声明", color: "#ef4444" } : { text: "未构建", color: "#f59e0b" });
								return react.createElement("div", { key: p.name, style: s.pluginCard },
									react.createElement("div", { style: s.row },
										react.createElement("p", { style: Object.assign({}, s.pluginTitle, { flex: 1, minWidth: 0 }) }, p.name),
										react.createElement("span", { style: { fontSize: 12, color: "#fff", background: badge.color, borderRadius: 10, padding: "2px 8px", whiteSpace: "nowrap" } }, badge.text),
										react.createElement("button", { type: "button", style: s.btn, onClick: function () { window.open("file:///" + p.dir.replace(/\\/g, "/"), "_blank"); } }, "打开目录")
									),
									p.description ? react.createElement("p", { style: s.pluginDesc }, String(p.description)) : null,
									p.status === "needs-deps" && p.imports && p.imports.length > 0
										? react.createElement("p", { style: { fontSize: 12, color: "#ef4444", margin: "4px 0 0" } }, "import 了但未声明： " + p.imports.join(", "))
										: null,
									react.createElement("p", { style: s.cmd }, "/dynload " + p.name + "　·　入口：" + String(p.entrySource || "?")),
									p.readme ? react.createElement("p", { style: s.pluginReadme }, String(p.readme)) : null,
									react.createElement("p", { style: s.meta }, p.dir)
								);
							})
						)
					)
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
