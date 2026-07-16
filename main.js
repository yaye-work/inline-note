"use strict";

const {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	setIcon,
	editorInfoField,
	debounce,
	Component,
	MarkdownRenderer,
} = require("obsidian");
const { Decoration, WidgetType, EditorView, keymap } = require("@codemirror/view");
const { StateEffect, StateField, Prec } = require("@codemirror/state");
const { history, defaultKeymap, historyKeymap } = require("@codemirror/commands");

let AUTOCOMPLETE = null;
try {
	AUTOCOMPLETE = require("@codemirror/autocomplete");
} catch (e) {
	/* fallback editor only: no [[ suggestions, all else works */
}

const MAX_DEPTH = 5;
const PREVIEW_LIMIT = 200;

const DEFAULT_SETTINGS = {
	nestStyle: "line", // "line" | "card" | "card-line"
};

/* ------------------------------------------------------------------ */
/* State. Each link is "closed", "preview" (truncated if the note is   */
/* long, the full body otherwise), or "full". Links in a real note     */
/* view open in preview by default; links inside inline bodies start   */
/* closed (otherwise chains of notes would cascade open).              */
/* ------------------------------------------------------------------ */

const setInlineState = StateEffect.define();

const inlineStateField = StateField.define({
	create() {
		return new Map();
	},
	update(value, tr) {
		let next = value;
		for (const e of tr.effects) {
			if (e.is(setInlineState)) {
				if (next === value) next = new Map(value);
				next.set(e.value.link, e.value.state);
			}
		}
		return next;
	},
});

function isMainEditor(state) {
	// a real note view has a workspace leaf; embedded editors
	// (inline bodies, canvas nodes) don't
	const info = state.field(editorInfoField, false);
	return !!(info && info.leaf);
}

function getInlineState(state, linkText) {
	const explicit = state.field(inlineStateField).get(linkText);
	return explicit || (isMainEditor(state) ? "preview" : "closed");
}

const LINK_RE = /\[\[([^\[\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;
const EMBED_RE = /!\[\[([^\[\]\n]+)\]\]/g;
// links like [[photo.png]] name a non-markdown file — never inline those
const NON_MD_EXT_RE = /\.(?!md$)[a-zA-Z0-9]{1,8}$/;

/* nested fallback editors reveal [[brackets]] only while focused with
 * the cursor inside the link — so we track focus as editor state */
const setFocused = StateEffect.define();

const focusedField = StateField.define({
	create() {
		return false;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setFocused)) value = e.value;
		}
		return value;
	},
});

function linkAt(state, pos, requireAtEnd) {
	const line = state.doc.lineAt(pos);
	LINK_RE.lastIndex = 0;
	let m;
	while ((m = LINK_RE.exec(line.text)) !== null) {
		// ![[...]] is an embed, not a toggleable link
		if (m.index > 0 && line.text[m.index - 1] === "!") continue;
		const start = line.from + m.index;
		const end = start + m[0].length;
		const hit = requireAtEnd ? pos === end : pos >= start && pos <= end;
		if (hit && m[1].trim()) return m[1].trim();
	}
	return null;
}

/* completion source for [[ inside FALLBACK editors: suggests vault
 * files. The native embedded editor uses Obsidian's own suggester. */
function linkCompletionSource(plugin) {
	return (ctx) => {
		const m = ctx.matchBefore(/!?\[\[[^\[\]]*$/);
		if (!m) return null;
		const from = m.from + m.text.indexOf("[[") + 2;
		const options = plugin.app.vault.getFiles().map((f) => {
			const label = f.extension === "md" ? f.basename : f.name;
			return { label, type: "file", apply: label + "]]" };
		});
		return { from, options, validFor: /^[^\[\]]*$/ };
	};
}

/* focus moving into Obsidian popovers (link suggester, menus, CM
 * tooltips) must not count as "left the inline body" */
function focusMovedToPopover(e) {
	return (
		e.relatedTarget instanceof Element &&
		!!e.relatedTarget.closest(".suggestion-container, .cm-tooltip, .menu, .modal-container")
	);
}

/* ------------------------------------------------------------------ */
/* Link toggle widget: chevron once the note exists (always visible),  */
/* file-plus while it doesn't (shows on line hover).                   */
/* ------------------------------------------------------------------ */

class LinkToggleWidget extends WidgetType {
	constructor(plugin, linkText, sourcePath, depth, exists, open, canInline) {
		super();
		this.plugin = plugin;
		this.linkText = linkText;
		this.sourcePath = sourcePath;
		this.depth = depth;
		this.exists = exists;
		this.open = open;
		this.canInline = canInline;
	}

	eq(other) {
		return (
			other.linkText === this.linkText &&
			other.exists === this.exists &&
			other.open === this.open &&
			other.canInline === this.canInline
		);
	}

	toDOM(view) {
		const btn = document.createElement("span");
		btn.className = "inline-note-btn";
		if (this.exists) btn.classList.add("is-visible");
		if (!this.exists) {
			btn.setAttribute("aria-label", "Create inline (Tab after ]])");
			setIcon(btn, "file-plus-2");
		} else if (!this.canInline) {
			btn.setAttribute("aria-label", "Open note");
			setIcon(btn, "lucide-external-link");
		} else {
			btn.setAttribute("aria-label", this.open ? "Collapse (Tab after ]])" : "Expand (Tab after ]])");
			setIcon(btn, this.open ? "chevron-down" : "chevron-right");
		}
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.exists && !this.canInline) {
				this.plugin.app.workspace.openLinkText(this.linkText, this.sourcePath, false);
				return;
			}
			this.plugin.toggleInlineNote(view, this.linkText, this.sourcePath, this.depth);
		});
		return btn;
	}

	ignoreEvent() {
		return true;
	}
}

/* ------------------------------------------------------------------ */
/* Embed widget: renders ![[...]] inside FALLBACK editors through      */
/* Obsidian's MarkdownRenderer (PDFs, images, note embeds).            */
/* ------------------------------------------------------------------ */

class EmbedWidget extends WidgetType {
	constructor(plugin, target, sourcePath) {
		super();
		this.plugin = plugin;
		this.target = target;
		this.sourcePath = sourcePath;
	}

	eq(other) {
		return other.target === this.target && other.sourcePath === this.sourcePath;
	}

	toDOM() {
		const el = document.createElement("span");
		el.className = "inline-note-embedded markdown-rendered";
		this._component = new Component();
		this._component.load();
		MarkdownRenderer.render(
			this.plugin.app,
			"![[" + this.target + "]]",
			el,
			this.sourcePath,
			this._component
		).catch(() => {
			el.textContent = "![[" + this.target + "]]";
		});
		el.addEventListener("mousedown", (e) => e.stopPropagation());
		return el;
	}

	destroy() {
		if (this._component) this._component.unload();
	}

	ignoreEvent() {
		return true;
	}
}

/* ------------------------------------------------------------------ */
/* Inline body. Idle: rendered reading view. Editing: Obsidian's own   */
/* embedded markdown editor (the Canvas mechanism) — live preview,     */
/* native commands, native suggester, native drag & drop. Falls back   */
/* to a bare CodeMirror editor when that internal API is unavailable.  */
/* ------------------------------------------------------------------ */

class InlineNoteWidget extends WidgetType {
	constructor(plugin, linkText, sourcePath, depth, ancestors, mode) {
		super();
		this.plugin = plugin;
		this.linkText = linkText;
		this.sourcePath = sourcePath;
		this.depth = depth;
		this.ancestors = ancestors;
		this.mode = mode; // "preview" | "full"
	}

	eq(other) {
		return (
			other.linkText === this.linkText &&
			other.sourcePath === this.sourcePath &&
			other.mode === this.mode
		);
	}

	toDOM(view) {
		const panel = buildInlineBody(
			this.plugin,
			this.linkText,
			this.sourcePath,
			this.depth,
			this.ancestors,
			this.mode,
			view
		);
		this._destroyPanel = panel.destroy;
		panel.el.addEventListener("mousedown", (e) => e.stopPropagation());
		return panel.el;
	}

	destroy() {
		if (this._destroyPanel) this._destroyPanel();
	}

	ignoreEvent() {
		return true;
	}
}

/** Paths of the inline bodies this element sits inside (DOM walk —
 * works across native embedded editors where CM state can't carry
 * ancestry). */
function domAncestorPaths(el) {
	const out = [];
	let cur = el;
	while ((cur = cur.parentElement)) {
		if (cur.classList.contains("inline-note-flow") && cur.dataset.notePath) {
			out.push(cur.dataset.notePath);
		}
	}
	return out;
}

function buildInlineBody(plugin, linkText, sourcePath, depth, ancestors, mode, parentView) {
	const app = plugin.app;

	const wrap = document.createElement("div");
	wrap.className = "inline-note-flow";

	let fallbackEditor = null; // CM EditorView (fallback path)
	let nativeEmbed = null; // Obsidian MarkdownEmbed (preferred path)
	let renderComponent = null;
	let dirty = false;
	let currentContent = "";
	let childSourcePath = sourcePath;
	let childAncestors = ancestors;

	const bodyText = () => {
		if (nativeEmbed) {
			try {
				if (nativeEmbed.editMode) {
					if (typeof nativeEmbed.editMode.get === "function") {
						return nativeEmbed.editMode.get();
					}
					const cm =
						nativeEmbed.editMode.editor && nativeEmbed.editMode.editor.cm;
					if (cm) return cm.state.doc.toString();
				}
			} catch (e) {
				/* fall through */
			}
			return null;
		}
		if (fallbackEditor) return fallbackEditor.state.doc.toString();
		return null;
	};

	const saveSelf = async () => {
		const file = plugin.resolveLink(linkText, sourcePath);
		if (!file) return;
		if (nativeEmbed) {
			const text = bodyText();
			if (text != null && text !== currentContent) {
				currentContent = text;
				await app.vault.modify(file, text);
			}
			return;
		}
		if (!fallbackEditor || !dirty) return;
		dirty = false;
		currentContent = fallbackEditor.state.doc.toString();
		await app.vault.modify(file, currentContent);
	};
	const debouncedSave = debounce(saveSelf, 500, true);

	const clearBody = () => {
		if (renderComponent) {
			renderComponent.unload();
			renderComponent = null;
		}
		if (nativeEmbed) {
			try {
				nativeEmbed.unload();
			} catch (e) {
				/* ignore */
			}
			nativeEmbed = null;
		}
		if (fallbackEditor) {
			fallbackEditor.destroy();
			fallbackEditor = null;
		}
		while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
	};

	const mdLinkFor = (file) => {
		let link = app.fileManager.generateMarkdownLink(file, childSourcePath);
		if (file.extension !== "md" && !link.startsWith("!")) link = "!" + link;
		return link;
	};

	const dropIsHandleable = (e) => {
		const dr = app.dragManager && app.dragManager.draggable;
		if (dr && (dr.file || (dr.files && dr.files.length))) return true;
		return !!(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length);
	};
	const collectDropLinks = async (e) => {
		const dr = app.dragManager && app.dragManager.draggable;
		const links = [];
		if (dr && (dr.file || (dr.files && dr.files.length))) {
			const files = dr.files || [dr.file];
			for (const f of files) {
				if (f && f.path) links.push(mdLinkFor(f));
			}
		} else if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
			for (const f of Array.from(e.dataTransfer.files)) {
				const path = app.fileManager.getAvailablePathForAttachment
					? await app.fileManager.getAvailablePathForAttachment(f.name, childSourcePath)
					: f.name;
				const buf = await f.arrayBuffer();
				const created = await app.vault.createBinary(path, buf);
				links.push(mdLinkFor(created));
			}
		}
		return links.length ? links.join("\n") : null;
	};

	/** shared exit path: reclaim an untouched empty note, otherwise
	 * save and drop back to the rendered view */
	const leaveBody = (text) => {
		currentContent = text != null ? text : currentContent;
		if (currentContent.trim() === "") {
			plugin
				.maybeReclaimEmpty(linkText, sourcePath, currentContent)
				.then((reclaimed) => {
					if (reclaimed) {
						dirty = false;
						parentView.dispatch({
							effects: setInlineState.of({ link: linkText, state: "closed" }),
						});
					} else {
						saveSelf();
						mountRendered();
					}
				});
			return;
		}
		saveSelf();
		mountRendered();
	};

	/* rendered (reading) view — real markdown incl. embeds */
	const mountRendered = () => {
		clearBody();
		const el = wrap.appendChild(document.createElement("div"));
		el.className = "inline-note-rendered markdown-rendered";
		renderComponent = new Component();
		renderComponent.load();
		if (currentContent.trim() === "") {
			const empty = el.appendChild(document.createElement("div"));
			empty.className = "inline-note-empty";
			empty.textContent = "Empty note — click to write.";
		} else {
			MarkdownRenderer.render(app, currentContent, el, childSourcePath, renderComponent).catch(
				() => {
					el.textContent = currentContent;
				}
			);
		}
		// dropping files onto the rendered body appends links/embeds
		el.addEventListener("dragover", (e) => {
			if (dropIsHandleable(e)) e.preventDefault();
		});
		el.addEventListener("drop", (e) => {
			if (!dropIsHandleable(e)) return;
			e.preventDefault();
			e.stopPropagation();
			collectDropLinks(e)
				.then(async (text) => {
					if (!text) return;
					const file = plugin.resolveLink(linkText, sourcePath);
					if (!file) return;
					currentContent =
						currentContent.trimEnd() === ""
							? text
							: currentContent.replace(/\n*$/, "\n") + text;
					await app.vault.modify(file, currentContent);
					mountRendered();
				})
				.catch((err) => new Notice("Inline Note: drop failed — " + err.message));
		});
		el.addEventListener("click", (e) => {
			const anchor =
				e.target instanceof Element && e.target.closest("a.internal-link");
			if (anchor) {
				e.preventDefault();
				const target =
					anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
				if (target)
					app.workspace.openLinkText(target, childSourcePath, e.metaKey || e.ctrlKey);
				return;
			}
			// let embeds and external links handle their own clicks
			if (
				e.target instanceof Element &&
				e.target.closest(".internal-embed, a.external-link, img, iframe, video, audio")
			) {
				return;
			}
			mountEditor();
		});
	};

	/* preferred editing view: Obsidian's own embedded editor (the
	 * Canvas mechanism). Returns a promise resolving to success. */
	const mountNative = async (file) => {
		const factory =
			app.embedRegistry &&
			app.embedRegistry.embedByExtension &&
			app.embedRegistry.embedByExtension.md;
		if (!factory) return false;
		const container = document.createElement("div");
		container.className = "inline-note-native markdown-rendered";
		try {
			const embed = factory({ app, containerEl: container, state: {} }, file, "");
			if (!embed || typeof embed.showEditor !== "function") return false;
			embed.editable = true;
			wrap.appendChild(container);
			embed.load();
			if (typeof embed.loadFile === "function") await embed.loadFile();
			embed.showEditor();
			if (!embed.editMode) {
				embed.unload();
				container.remove();
				return false;
			}
			nativeEmbed = embed;

			// editor commands (bold, checkbox, …) target the active editor
			container.addEventListener("focusin", () => {
				try {
					app.workspace.activeEditor = embed;
				} catch (e) {
					/* ignore */
				}
			});
			container.addEventListener("focusout", (e) => {
				if (e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) return;
				if (focusMovedToPopover(e)) return;
				if (!nativeEmbed) return;
				leaveBody(bodyText());
			});

			// focus the editor so typing starts immediately
			const cm = embed.editMode.editor && embed.editMode.editor.cm;
			if (cm && typeof cm.focus === "function") cm.focus();
			else {
				const content = container.querySelector(".cm-content");
				if (content) content.focus();
			}
			return true;
		} catch (e) {
			console.error("inline-note: native editor failed, falling back", e);
			try {
				if (nativeEmbed) nativeEmbed.unload();
			} catch (e2) {
				/* ignore */
			}
			nativeEmbed = null;
			container.remove();
			return false;
		}
	};

	/* fallback editing view: bare CodeMirror */
	const mountFallback = () => {
		fallbackEditor = new EditorView({
			doc: currentContent,
			parent: wrap,
			extensions: [
				history(),
				keymap.of([...historyKeymap, ...defaultKeymap]),
				EditorView.lineWrapping,
				focusedField,
				EditorView.updateListener.of((u) => {
					if (u.docChanged) {
						dirty = true;
						debouncedSave();
					}
					if (u.focusChanged) {
						const focused = u.view.hasFocus;
						queueMicrotask(() =>
							u.view.dispatch({ effects: setFocused.of(focused) })
						);
					}
				}),
				...(AUTOCOMPLETE
					? [
							AUTOCOMPLETE.autocompletion({
								override: [linkCompletionSource(plugin)],
								icons: false,
							}),
							keymap.of(AUTOCOMPLETE.completionKeymap),
					  ]
					: []),
				EditorView.domEventHandlers({
					mousedown: (e, view) => {
						const el =
							e.target instanceof Element &&
							e.target.closest(".inline-note-link-clickable");
						if (!el) return false;
						const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
						if (pos == null) return false;
						const target = linkAt(view.state, pos, false);
						if (!target) return false;
						e.preventDefault();
						app.workspace.openLinkText(
							target,
							childSourcePath,
							e.metaKey || e.ctrlKey
						);
						return true;
					},
					dragover: (e) => {
						if (!dropIsHandleable(e)) return false;
						e.preventDefault();
						return true;
					},
					drop: (e, view) => {
						if (!dropIsHandleable(e)) return false;
						e.preventDefault();
						const pos =
							view.posAtCoords({ x: e.clientX, y: e.clientY }) ??
							view.state.selection.main.head;
						collectDropLinks(e)
							.then((text) => {
								if (!text || !fallbackEditor) return;
								fallbackEditor.dispatch({
									changes: { from: pos, insert: text },
									selection: { anchor: pos + text.length },
								});
								fallbackEditor.focus();
							})
							.catch((err) =>
								new Notice("Inline Note: drop failed — " + err.message)
							);
						return true;
					},
				}),
				buildInlineExtensions(
					plugin,
					() => childSourcePath,
					depth,
					() => childAncestors
				),
				EditorView.contentAttributes.of({ "aria-label": linkText }),
			],
		});
		fallbackEditor.dom.classList.add("inline-note-editor");
		fallbackEditor.dom.addEventListener("focusout", (e) => {
			if (e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget)) return;
			if (focusMovedToPopover(e)) return;
			if (!fallbackEditor) return;
			leaveBody(fallbackEditor.state.doc.toString());
		});
		fallbackEditor.focus();
	};

	const mountEditor = () => {
		clearBody();
		const file = plugin.resolveLink(linkText, sourcePath);
		if (file) {
			mountNative(file).then((ok) => {
				if (!ok && wrap.isConnected && !nativeEmbed && !fallbackEditor) {
					clearBody();
					mountFallback();
				}
			});
		} else {
			mountFallback();
		}
	};

	const mountPreview = () => {
		clearBody();
		const preview = wrap.appendChild(document.createElement("div"));
		preview.className = "inline-note-preview";
		preview.textContent = currentContent.slice(0, PREVIEW_LIMIT).trimEnd() + "…";
		preview.setAttribute("aria-label", "Expand (Tab after ]])");
		preview.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			plugin._pendingFocus = linkText;
			parentView.dispatch({
				effects: setInlineState.of({ link: linkText, state: "full" }),
			});
		});
	};

	// The file may have been created a moment ago and the metadata cache
	// might not have caught up yet — retry resolution briefly.
	const loadContent = (attempt) => {
		const file = plugin.resolveLink(linkText, sourcePath);
		if (file) {
			// guard against cycles and runaway nesting across native
			// editors, where CM state can't carry ancestry — the DOM can
			const domAnc = domAncestorPaths(wrap);
			const allAnc = ancestors.concat(domAnc);
			if (allAnc.includes(file.path) || domAnc.length >= MAX_DEPTH) {
				const msg = wrap.appendChild(document.createElement("div"));
				msg.className = "inline-note-error";
				msg.textContent = allAnc.includes(file.path)
					? "Already open above — click to open in a tab."
					: "Max nesting depth — click to open in a tab.";
				msg.style.cursor = "pointer";
				msg.addEventListener("click", () =>
					app.workspace.openLinkText(linkText, sourcePath, false)
				);
				return;
			}
			wrap.dataset.notePath = file.path;
			childSourcePath = file.path;
			childAncestors = ancestors.concat([file.path]);
			app.vault.read(file).then((content) => {
				currentContent = content;
				if (mode === "preview" && content.length > PREVIEW_LIMIT) {
					mountPreview();
				} else if (plugin.consumePendingFocus(linkText)) {
					mountEditor();
				} else {
					mountRendered();
				}
			});
		} else if (attempt < 10) {
			window.setTimeout(() => loadContent(attempt + 1), 100);
		} else {
			const err = wrap.appendChild(document.createElement("div"));
			err.className = "inline-note-error";
			err.textContent = "Note not found: " + linkText;
		}
	};
	loadContent(0);

	return {
		el: wrap,
		destroy: () => {
			saveSelf();
			clearBody();
		},
	};
}

/* ------------------------------------------------------------------ */
/* Shared editor extensions (main editor and every nested editor)      */
/* ------------------------------------------------------------------ */

function buildDecorationField(plugin, getSourcePath, depth, getAncestors) {
	const linkEditingMark = Decoration.mark({ class: "inline-note-link" });
	const linkClickableMark = Decoration.mark({
		class: "inline-note-link inline-note-link-clickable",
	});
	const hideMark = Decoration.replace({});

	const selectionTouches = (state, from, to) => {
		for (const r of state.selection.ranges) {
			if (r.to >= from && r.from <= to) return true;
		}
		return false;
	};

	const buildDecos = (state) => {
		const decos = [];
		const sourcePath = getSourcePath(state);
		const ancestors = getAncestors(state);
		const rendered = new Set();

		const text = state.doc.toString();

		// ![[embeds]] inside fallback editors render through Obsidian's
		// MarkdownRenderer; raw text is shown while the cursor touches them
		if (depth > 0) {
			EMBED_RE.lastIndex = 0;
			let em;
			while ((em = EMBED_RE.exec(text)) !== null) {
				const target = em[1].trim();
				if (!target) continue;
				const start = em.index;
				const end = start + em[0].length;
				if (!selectionTouches(state, start, end)) {
					decos.push(
						Decoration.replace({
							widget: new EmbedWidget(plugin, target, sourcePath),
						}).range(start, end)
					);
				}
			}
		}

		LINK_RE.lastIndex = 0;
		let m;
		while ((m = LINK_RE.exec(text)) !== null) {
			// skip the [[...]] inside ![[...]] embeds
			if (m.index > 0 && text[m.index - 1] === "!") continue;
			const linkText = m[1].trim();
			if (!linkText) continue;
			const start = m.index;
			const end = start + m[0].length;

			// inside fallback editors there's no Obsidian markdown mode, so
			// style [[links]] ourselves — like live preview, the brackets
			// are hidden unless the cursor is inside the link
			if (depth > 0) {
				const revealed =
					state.field(focusedField, false) && selectionTouches(state, start, end);
				if (revealed) {
					decos.push(linkEditingMark.range(start, end));
				} else {
					decos.push(hideMark.range(start, start + 2));
					decos.push(linkClickableMark.range(start + 2, end - 2));
					decos.push(hideMark.range(end - 2, end));
				}
			}

			const file = plugin.resolveLink(linkText, sourcePath);
			// only markdown notes are inline-able; links to PDFs, images,
			// and other binary files keep Obsidian's native behavior —
			// no button, no inline body, and never a raw binary read
			const isMd = file
				? file.extension === "md"
				: !NON_MD_EXT_RE.test(linkText);
			if (!isMd) continue;

			const exists = !!file;
			// no inline body for links that would recurse into an ancestor
			// (self-links, A→B→A loops) or past the depth cap
			const canInline = exists && depth < MAX_DEPTH && !ancestors.includes(file.path);
			const inlineState = getInlineState(state, linkText);
			const open =
				canInline && inlineState !== "closed" && !rendered.has(linkText);

			decos.push(
				Decoration.widget({
					widget: new LinkToggleWidget(plugin, linkText, sourcePath, depth, exists, open, canInline),
					side: 1,
				}).range(end)
			);

			if (open) {
				rendered.add(linkText);
				const line = state.doc.lineAt(end);
				decos.push(
					Decoration.widget({
						widget: new InlineNoteWidget(
							plugin,
							linkText,
							sourcePath,
							depth + 1,
							ancestors,
							inlineState
						),
						side: 2,
						block: true,
					}).range(line.to)
				);
			}
		}
		return Decoration.set(decos, true);
	};

	return StateField.define({
		create(state) {
			return buildDecos(state);
		},
		update(value, tr) {
			if (
				tr.docChanged ||
				// fallback editors reveal/hide brackets and embeds as the
				// cursor moves or the editor gains/loses focus
				(depth > 0 && tr.selection) ||
				tr.effects.some((e) => e.is(setFocused) || e.is(setInlineState))
			) {
				return buildDecos(tr.state);
			}
			return value;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildToggleKeymap(plugin, getSourcePath, depth) {
	return Prec.high(
		keymap.of([
			{
				// Tab immediately after "]]": cycle the inline note —
				// create+open if missing, preview → full for long notes,
				// then collapse. Never fires elsewhere, so indentation is
				// safe.
				key: "Tab",
				run: (view) => {
					const linkText = linkAt(view.state, view.state.selection.main.head, true);
					if (!linkText) return false;
					plugin.toggleInlineNote(view, linkText, getSourcePath(view.state), depth);
					return true;
				},
			},
		])
	);
}

function buildInlineExtensions(plugin, getSourcePath, depth, getAncestors) {
	return [
		inlineStateField,
		buildDecorationField(plugin, getSourcePath, depth, getAncestors),
		buildToggleKeymap(plugin, getSourcePath, depth),
	];
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class InlineNoteSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Nesting style")
			.setDesc("How inline note bodies are rendered.")
			.addDropdown((dd) =>
				dd
					.addOption("line", "Vertical accent line")
					.addOption("card", "Card (background only)")
					.addOption("card-line", "Card + vertical accent line")
					.setValue(this.plugin.settings.nestStyle)
					.onChange(async (value) => {
						this.plugin.settings.nestStyle = value;
						this.plugin.applyNestStyle();
						await this.plugin.saveSettings();
					})
			);
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class InlineNotePlugin extends Plugin {
	async onload() {
		this._pendingFocus = null;
		// notes this plugin created this session — candidates for reclaim
		// (deletion) if they're still empty when their inline body closes
		this._createdInline = new Set();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.applyNestStyle();
		this.addSettingTab(new InlineNoteSettingTab(this.app, this));

		const getRootSourcePath = (state) => {
			const info = state.field(editorInfoField, false);
			return (info && info.file && info.file.path) || "";
		};
		const getRootAncestors = (state) => {
			const p = getRootSourcePath(state);
			return p ? [p] : [];
		};
		this.registerEditorExtension(
			buildInlineExtensions(this, getRootSourcePath, 0, getRootAncestors)
		);

		this.addCommand({
			id: "toggle-inline-note-at-cursor",
			name: "Toggle inline note for link under cursor",
			editorCallback: async (editor, ctx) => {
				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line);
				LINK_RE.lastIndex = 0;
				let m;
				let target = null;
				while ((m = LINK_RE.exec(lineText)) !== null) {
					if (m.index > 0 && lineText[m.index - 1] === "!") continue;
					if (cursor.ch >= m.index && cursor.ch <= m.index + m[0].length) {
						target = m[1].trim();
						break;
					}
				}
				if (!target) {
					new Notice("No [[link]] under cursor.");
					return;
				}
				const sourcePath = (ctx && ctx.file && ctx.file.path) || "";
				if (editor.cm) this.toggleInlineNote(editor.cm, target, sourcePath, 0);
			},
		});
	}

	onunload() {
		document.body.classList.remove(
			"inline-note-style-line",
			"inline-note-style-card",
			"inline-note-style-card-line"
		);
	}

	applyNestStyle() {
		document.body.classList.remove(
			"inline-note-style-line",
			"inline-note-style-card",
			"inline-note-style-card-line"
		);
		document.body.classList.add("inline-note-style-" + this.settings.nestStyle);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	consumePendingFocus(linkText) {
		if (this._pendingFocus === linkText) {
			this._pendingFocus = null;
			return true;
		}
		return false;
	}

	/** Cycle the inline note: create+open if missing; closed → preview;
	 * preview → full (long notes) or closed (short, already fully shown);
	 * full → closed. */
	async toggleInlineNote(view, linkText, sourcePath, depth) {
		if (depth >= MAX_DEPTH) {
			new Notice("Inline Note: max nesting depth reached — opening in a tab.");
			this.app.workspace.openLinkText(linkText, sourcePath, false);
			return;
		}
		try {
			const existing = this.resolveLink(linkText, sourcePath);
			// non-markdown targets (images, PDFs, …) are never inlined
			if (existing && existing.extension !== "md") {
				this.app.workspace.openLinkText(linkText, sourcePath, false);
				return;
			}
			if (!existing && NON_MD_EXT_RE.test(linkText)) {
				new Notice("Inline Note: not a markdown note.");
				return;
			}
			const existedBefore = !!existing;
			const file = await this.ensureFile(linkText, sourcePath);
			let content = "";
			try {
				content = await this.app.vault.cachedRead(file);
			} catch (e) {
				/* new file, no cache yet */
			}
			const long = content.length > PREVIEW_LIMIT;
			const current = getInlineState(view.state, linkText);

			let next;
			if (!existedBefore) next = "preview"; // brand-new note: empty, opens as editor
			else if (current === "closed") next = "preview";
			else if (current === "preview") next = long ? "full" : "closed";
			else next = "closed";

			const opensBody = next === "full" || (next === "preview" && !long);
			// focus the editor when opening via keyboard so typing can start
			// immediately — except a long note's truncated preview
			if (opensBody) this._pendingFocus = linkText;
			view.dispatch({ effects: setInlineState.of({ link: linkText, state: next }) });
			// Collapsing destroys the nested editor; if it held keyboard
			// focus, focus would silently fall to <body>, which other
			// plugins (e.g. graph preview panes watching focusin/focusout)
			// read as "the user left the pane". Hand focus to the editor
			// that owns the link instead.
			if (next === "closed") {
				view.focus();
				// If this was a note we created and it's still empty,
				// remove it again — an accidental click shouldn't leave
				// stray blank notes. Wait out the body's closing save
				// first so freshly typed text is never misjudged.
				window.setTimeout(() => {
					this.maybeReclaimEmpty(linkText, sourcePath, null).then((reclaimed) => {
						if (reclaimed) {
							view.dispatch({
								effects: setInlineState.of({ link: linkText, state: "closed" }),
							});
						}
					});
				}, 600);
			}
		} catch (err) {
			new Notice("Inline Note: could not create note — " + err.message);
		}
	}

	/** Resolve a link target, falling back to a direct path lookup while
	 * the metadata cache catches up on a freshly created file. */
	resolveLink(linkText, sourcePath) {
		const viaCache = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
		if (viaCache) return viaCache;
		const folder = this.app.fileManager.getNewFileParent(sourcePath);
		const path = (folder.path === "/" ? "" : folder.path + "/") + linkText + ".md";
		const direct = this.app.vault.getFileByPath
			? this.app.vault.getFileByPath(path)
			: this.app.vault.getAbstractFileByPath(path);
		return direct || null;
	}

	/** Create the linked note (as a real file) if it doesn't exist yet. */
	async ensureFile(linkText, sourcePath) {
		const existing = this.resolveLink(linkText, sourcePath);
		if (existing) return existing;
		const folder = this.app.fileManager.getNewFileParent(sourcePath);
		const path = (folder.path === "/" ? "" : folder.path + "/") + linkText + ".md";
		const created = await this.app.vault.create(path, "");
		this._createdInline.add(created.path);
		return created;
	}

	/** If `linkText` resolves to a note this plugin created this session
	 * and it's (still) empty, move it to trash. Never touches notes the
	 * plugin didn't create. Returns true when the note was reclaimed. */
	async maybeReclaimEmpty(linkText, sourcePath, knownContent) {
		const file = this.resolveLink(linkText, sourcePath);
		if (!file || file.extension !== "md") return false;
		if (!this._createdInline.has(file.path)) return false;
		let content = knownContent;
		if (content == null) {
			try {
				content = await this.app.vault.read(file);
			} catch (e) {
				return false;
			}
		}
		if (content.trim() !== "") return false;
		this._createdInline.delete(file.path);
		if (this.app.fileManager.trashFile) {
			await this.app.fileManager.trashFile(file);
		} else {
			await this.app.vault.trash(file, true);
		}
		new Notice("Inline Note: removed empty note “" + linkText + "”.");
		return true;
	}
}

module.exports = InlineNotePlugin;
