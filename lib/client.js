/**
 * dsh-ability-strip — browser half.
 *
 * A thin strip docked under the composer, inside the input bar's own dock. It
 * answers one question: *what does THIS session actually have available?* — as
 * two marks that never merge:
 *
 *   - **skill**  how many human-invocable skills this session sees (`skills/list`)
 *   - **MCP**    whether any MCP server actually connected, judged by whether
 *                `mcp__<server>__*` tools are registered in the live tool registry
 *                (read via this package's own host half over `/api/ability-strip`)
 *
 * The detail panel floats above the page (portalled, fixed) and lists the skills,
 * the connected MCP servers with tool counts, the configured Loader rows, and the
 * profile's enabled bundles. A fault (MCP enabled but zero tools) opens a dialog
 * on its own.
 *
 * Read-only by construction: it calls three read-only Remotes plus one read of
 * its own host half. It registers no tool, writes no setting, and changes no
 * content.
 *
 * Lazy-CJS bundle form: executing this script only registers the factory;
 * every module-body side effect lives inside it.
 */
window.__ModuleLoader__.load({
	id: "dsh-ability-strip",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");

		/**
		 * Cordis services this plugin waits for. Cordis gates every service read
		 * behind a declared name, so each Remote namespace the strip reads is
		 * listed here beside the base `remote` service. `sessions` is absent on
		 * purpose: the session id arrives as a built-in standard prop of the
		 * session-scoped dock slot, so the sessions service is never read and
		 * declaring it would only delay activation behind an unused service.
		 */
		const inject = [
			"slots",
			"remote",
			"remote.skills",
			"remote.pluginInventory",
			"remote.pluginManager",
			// The Connection carrier: how this half reaches its own host half to read
			// the tool registry, which no browser Remote exposes.
			"connection",
		];

		/** MCP client module specifier; a Loader row naming it is one MCP server. */
		const MCP_MODULE = "@deepseek-ai/dsh-mcp-client";

		/**
		 * MCP resource plugin. Shipped profiles mount it once for all servers, so it
		 * is NOT a server row: it never joins the server list, but its presence is
		 * still worth stating, because without it a configured server exposes tools
		 * and no readable resources.
		 */
		const MCP_RESOURCES_MODULE = "@deepseek-ai/dsh-mcp-resources";

		/**
		 * Endpoint this package's host half owns inside the shared `/api` channel.
		 * Must stay identical to `ROUTE_ENDPOINT` in `lib/index.js`: the host
		 * registers `path: /api/<endpoint>` and `rpc.call` posts to the same pair.
		 */
		const TOOL_ENDPOINT = "ability-strip";

		/**
		 * How often the strip re-reads on its own, in milliseconds.
		 *
		 * The registry is read, not watched: DSH emits `tools/change` on the Host,
		 * but forwarding that to the browser requires a Typert Remote Event
		 * declaration — far more machinery than a read-only strip justifies. Fifteen
		 * seconds is frequent enough that a dropped server shows up while the reader
		 * is still looking, and cheap enough that four reads per minute are invisible.
		 */
		const POLL_INTERVAL_MS = 15_000;

		/** Muted inline text for a pending or absent answer. */
		const MUTED = { fontSize: 11, opacity: 0.55 };

		/** The skill count: tabular figures so the width does not jitter per value. */
		const COUNT = { fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 10 };

		/**
		 * Hairline divider drawn from the inherited text color, so it follows the
		 * theme. The vertical form takes an explicit height instead of stretching:
		 * a stretching divider would be as tall as the tallest sibling line.
		 */
		function Divider({ vertical }) {
			return h("span", {
				"aria-hidden": true,
				style: vertical
					? { flex: "0 0 auto", width: 1, height: 12, background: "currentColor", opacity: 0.16 }
					: { flex: "0 0 auto", height: 1, width: "100%", background: "currentColor", opacity: 0.16 },
			});
		}

		/**
		 * Copy one thrown value into a short line.
		 * @param error - whatever the call threw.
		 * @returns one-line diagnostic.
		 */
		function describeError(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}

		/**
		 * Compare two payloads by the fields the strip actually renders.
		 *
		 * A poll exists to notice a changed answer, so an identical answer must not
		 * reach `setState`: that would rebuild the row, invalidate the memo, and
		 * repaint every interval for nothing. `loadedAt` is deliberately excluded —
		 * it always differs, and suppressing it means the panel's "读取于" timestamp
		 * reflects when the visible content was actually obtained, not when the last
		 * poll happened.
		 * @param previous - payload currently on screen, possibly undefined.
		 * @param next - payload just read.
		 * @returns true when nothing the reader sees has changed.
		 */
		function samePayload(previous, next) {
			if (previous === void 0 || next === void 0) return previous === next;
			// Errors are compared by message: a different failure is news.
			// Optional chaining throughout: `loadAll` guarantees these fields, but a
			// defensive read costs nothing and prevents a throw from a malformed payload.
			if (previous.skills?.error !== next.skills?.error) return false;
			if (previous.inventory?.error !== next.inventory?.error) return false;
			if (previous.bundles?.error !== next.bundles?.error) return false;
			if (previous.tools?.error !== next.tools?.error) return false;
			if ((previous.skills?.entries?.length ?? 0) !== (next.skills?.entries?.length ?? 0)) {
				return false;
			}
			// Skill entry content matters too: a rewritten description or a changed
			// `whenToUse` is news the reader should see.
			const prevSkills = previous.skills?.entries ?? [];
			const nextSkills = next.skills?.entries ?? [];
			for (let index = 0; index < prevSkills.length; index += 1) {
				if (prevSkills[index]?.name !== nextSkills[index]?.name) return false;
				if (prevSkills[index]?.description !== nextSkills[index]?.description) return false;
				if (prevSkills[index]?.whenToUse !== nextSkills[index]?.whenToUse) return false;
				if (prevSkills[index]?.modelInvocable !== nextSkills[index]?.modelInvocable) return false;
			}
			// MCP is the field that changes in practice, and the reason the poll
			// exists: compare the server list, each server's tool count, and the tool
			// names (a rename is visible in the panel).
			const before = previous.tools?.servers ?? [];
			const after = next.tools?.servers ?? [];
			if (before.length !== after.length) return false;
			for (let index = 0; index < before.length; index += 1) {
				if (before[index].server !== after[index].server) return false;
				const prevTools = before[index].tools ?? [];
				const nextTools = after[index].tools ?? [];
				if (prevTools.length !== nextTools.length) return false;
				for (let t = 0; t < prevTools.length; t += 1) {
					if (prevTools[t] !== nextTools[t]) return false;
				}
			}
			// Loader rows: enablement and phase are what the panel prints.
			const prevRows = previous.mcpRows ?? [];
			const nextRows = next.mcpRows ?? [];
			if (prevRows.length !== nextRows.length) return false;
			for (let index = 0; index < prevRows.length; index += 1) {
				if (prevRows[index].entryId !== nextRows[index].entryId) return false;
				if (prevRows[index].enabled !== nextRows[index].enabled) return false;
				if (prevRows[index].fiberPhase !== nextRows[index].fiberPhase) return false;
			}
			if ((previous.mcpResources == null) !== (next.mcpResources == null)) return false;
			if (
				previous.mcpResources != null &&
				next.mcpResources != null
			) {
				if (previous.mcpResources.enabled !== next.mcpResources.enabled) return false;
				if (previous.mcpResources.entryId !== next.mcpResources.entryId) return false;
			}
			const beforeBundles = previous.bundles?.bundles ?? [];
			const afterBundles = next.bundles?.bundles ?? [];
			if (beforeBundles.length !== afterBundles.length) return false;
			for (let index = 0; index < beforeBundles.length; index += 1) {
				if (beforeBundles[index].name !== afterBundles[index].name) return false;
				if (beforeBundles[index].enabled !== afterBundles[index].enabled) return false;
				if (beforeBundles[index].version !== afterBundles[index].version) return false;
				if ((beforeBundles[index].rows?.length ?? 0) !== (afterBundles[index].rows?.length ?? 0)) {
					return false;
				}
			}
			return true;
		}

		/**
		 * Read one session-addressed skill catalog.
		 * @param remote - the client remote service.
		 * @param sessionId - session whose composition selects the catalog view.
		 * @returns the catalog, or a diagnostic instead of a throw.
		 */
		async function readSkills(remote, sessionId) {
			const skills = remote?.skills;
			if (skills === void 0) return { error: "skills Remote 未挂载" };
			try {
				const result = await skills.list({ sessionId });
				if (!result.ok) {
					return { error: `${result.error.code}: ${result.error.message}` };
				}
				return { entries: result.value.skills };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Read the Loader inventory (every non-group entry plus preset rows).
		 * @param remote - the client remote service.
		 * @returns the snapshot, or a diagnostic instead of a throw.
		 */
		async function readInventory(remote) {
			const inventory = remote?.pluginInventory;
			if (inventory === void 0) return { error: "pluginInventory Remote 未挂载" };
			try {
				const result = await inventory.list();
				if (!result.ok) {
					return { error: `${result.error.code}: ${result.error.message}` };
				}
				return { snapshot: result.value };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Read the profile's bundles and the patch rows each one declares.
		 * @param remote - the client remote service.
		 * @returns the bundle list, or a diagnostic instead of a throw.
		 */
		async function readBundles(remote) {
			const manager = remote?.pluginManager;
			if (manager === void 0) return { error: "pluginManager Remote 未挂载" };
			try {
				const result = await manager.listBundles();
				if (!result.ok) {
					return { error: `${result.error.code}: ${result.error.message}` };
				}
				return { bundles: result.value };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Render a Loader entry id the way its patch spells it: the composed tree
		 * prefixes rows with their owning include, which is noise in this list.
		 * @param entryId - composed Loader entry identity.
		 * @returns the row id without a leading `include:` segment.
		 */
		function rowLabel(entryId) {
			const text = String(entryId);
			return text.startsWith("include:") ? text.slice("include:".length) : text;
		}

		/**
		 * Per-row MCP mark. A phase icon replaces a bare status dot: the dot read as
		 * an unlabeled bullet, while these icons carry the same meaning as the
		 * Loader phase vocabulary. This is a LOADER phase, not connection health —
		 * an active row whose server is down still shows the active icon.
		 * @param row - one inventory entry naming the MCP client module.
		 * @returns the icon element for that row.
		 */
		function mcpPhaseIcon(row) {
			const size = 13;
			if (!row.enabled) return h(ui.IconPauseOutlineRegular, { size });
			if (row.fiberPhase === "failed") return h(ui.IconWarningOutlineRegular, { size });
			if (row.fiberPhase === "active") return h(ui.IconCheckCircleOutlineRegular, { size });
			if (row.fiberPhase === "loading") return h(ui.IconLoadingOutlineRegular, { size });
			return h(ui.IconClockOutlineRegular, { size });
		}

		/**
		 * Read the live tool registry from this plugin's own host half.
		 *
		 * The browser cannot see the tool registry, and that registry is the only
		 * browser-reachable evidence that an MCP server actually connected: a server
		 * that fails to connect registers no `mcp__<server>__*` tools. The host half
		 * of THIS package serves that answer, so no third-party plugin is involved.
		 * @param connection - the client Connection service.
		 * @returns the tool summary, or a diagnostic instead of a throw.
		 */
		async function readTools(connection) {
			if (connection === void 0) return { error: "connection 服务未挂载" };
			try {
				// Channel `/api`, endpoint `ability-strip` — the same pair the host half
				// registers as the route path below `/api`. The leading slash is NOT
				// cosmetic: `rpc.call` builds the URL as `${channel}/${endpoint}`.slice(1),
				// so `"api"` gets sliced to `"pi/..."` and misses the route entirely.
				const response = await connection.rpc.call("/api", TOOL_ENDPOINT, void 0);
				if (!response.ok) {
					return { error: `${response.error?.code ?? "unknown"}: ${response.error?.message ?? "连接失败"}` };
				}
				const value = response.value;
				// The host half answers `{ ok, ... }` inside the envelope; a failed
				// registry read arrives here rather than as a transport error.
				if (value?.ok === false) {
					return { error: typeof value.error === "string" ? value.error : "宿主读取工具清单失败" };
				}
				return { servers: value?.servers ?? [], totalTools: value?.totalTools ?? 0 };
			} catch (error) {
				return { error: describeError(error) };
			}
		}

		/**
		 * Load the strip's whole payload. Blocks fail independently so one missing
		 * Remote never blanks the other group.
		 * @param remote - the client remote service.
		 * @param sessionId - session to read the skill catalog for.
		 * @param connection - the client Connection service (host tool route).
		 * @returns one settled payload for the strip.
		 */
		async function loadAll(remote, sessionId, connection) {
			const [skills, inventory, bundles, tools] = await Promise.all([
				readSkills(remote, sessionId),
				readInventory(remote),
				readBundles(remote),
				readTools(connection),
			]);
			const entries = inventory.snapshot?.entries ?? [];
			return {
				skills,
				inventory,
				bundles,
				tools,
				mcpRows: entries.filter((entry) => entry.moduleName === MCP_MODULE),
				// The resource plugin is mounted once, not per server; keep it apart so
				// it never inflates the server list.
				mcpResources:
					entries.find((entry) => entry.moduleName === MCP_RESOURCES_MODULE) ?? null,
				loadedAt: new Date().toLocaleTimeString(),
			};
		}

		/**
		 * One skill row. The name renders as `/name` because that is how the
		 * composer references a human-invocable skill; `whenToUse` is the catalog's
		 * optional extra routing guidance and is shown under the description.
		 */
		function SkillRow({ entry }) {
			const muted = { fontSize: 11.5, opacity: 0.66, lineHeight: 1.5 };
			return h(
				"div",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 1,
						padding: "5px 0",
						borderBottom: "1px solid currentColor",
						borderBottomColor: "color-mix(in srgb, currentColor 10%, transparent)",
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
					h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, `/${entry.name}`),
					h(
						ui.Tag,
						{ tone: entry.modelInvocable ? "neutral" : "quiet" },
						entry.modelInvocable ? "model+user" : "user-only",
					),
				),
				entry.description !== "" && entry.description !== void 0
					? h("div", { style: muted }, entry.description)
					: null,
				entry.whenToUse !== "" && entry.whenToUse !== void 0
					? h("div", { style: { ...muted, opacity: 0.55 } }, entry.whenToUse)
					: null,
			);
		}

		/** One configured MCP client row: dot, row id, and its Loader state. */
		function McpRow({ row }) {
			const state = row.enabled ? "已启用" : "已停用";
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "5px 0",
						borderBottom: "1px solid currentColor",
						borderBottomColor: "color-mix(in srgb, currentColor 10%, transparent)",
					},
				},
				h("span", { style: { display: "flex", alignItems: "center" } }, mcpPhaseIcon(row)),
				h("span", { style: { fontSize: 12.5, fontWeight: 600 } }, rowLabel(row.entryId)),
				h("span", { style: { marginLeft: "auto" } }, h(
					ui.Tag,
					{ tone: row.enabled ? (row.fiberPhase === "failed" ? "danger" : "success") : "quiet" },
					`${state} · ${row.fiberPhase ?? "无状态"}`,
				)),
			);
		}

		/** Group heading: an icon, the group name, and its count. */
		function GroupHeading({ icon, name, count, note }) {
			return h(
				"div",
				{
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6,
						padding: "8px 0 4px",
					},
				},
				icon,
				h("span", { style: { fontSize: 12, fontWeight: 600 } }, name),
				count === void 0 ? null : h(ui.Tag, { tone: "neutral" }, String(count)),
				note === void 0
					? null
					: h("span", { style: { marginLeft: "auto", fontSize: 11, opacity: 0.6 } }, note),
			);
		}

		/** The docked strip. */
		function RuntimeStrip(props) {
			const { sessionId, load } = props;
			const [open, setOpen] = React.useState(false);
			const [state, setState] = React.useState({ phase: "idle" });
			// The fault dialog opens itself once per fault, and can be re-opened from
			// the MCP mark. `acknowledged` remembers the fault the reader has already
			// seen, so a 15-second poll cannot re-nag every tick.
			const [alertOpen, setAlertOpen] = React.useState(false);
			const acknowledgedFault = React.useRef(void 0);
			// The floating panel is placed from this row's live rect.
			const anchorRef = React.useRef(null);

			// The renderer caches an inject face per registration × scope binding, so
			// `load` is identity-stable for one Session. A ref keeps the effect keyed
			// on `sessionId` alone rather than on that closure's identity, which keeps
			// the fetch tied to the Session the reader is actually looking at.
			const loadRef = React.useRef(load);
			React.useEffect(() => {
				loadRef.current = load;
			}, [load]);

			// Monotonic request id: a superseded fetch must not overwrite the newer
			// answer when the reader switches sessions mid-flight.
			const requestId = React.useRef(0);
			// In-flight guard for the poll. Without it a read that outlives the
			// interval would stack requests on every tick.
			const inFlight = React.useRef(false);
			// When `run` is called while a read is in flight (session switch, manual
			// refresh during a poll), the caller's result must replace the in-flight
			// one. Without this the in-flight read's result would be written to the
			// new session's state because `requestId` was never incremented.
			const rerunPending = React.useRef(false);

			const run = React.useCallback(
				async (options) => {
					// The session id arrives as a standard prop of this session-scoped
					// slot, so the inject face never has to carry it. Without one there is
					// no catalog to read: stay pending rather than reporting a failure.
					if (sessionId === void 0) return;
					// One read at a time. A slow Host must not be asked again before it
					// answered: the tick simply skips and the next one retries.
					if (inFlight.current) {
						// Invalidate the in-flight read so its stale result is discarded,
						// and schedule a re-read when it settles.
						requestId.current += 1;
						rerunPending.current = true;
						return;
					}
					inFlight.current = true;
					const id = requestId.current + 1;
					requestId.current = id;
					// A silent re-read (the poll) must not flip the strip into its loading
					// state on every tick: that would repaint the row and, worse, look like
					// a user-initiated read. Only an explicit refresh shows progress.
					if (options?.silent !== true) {
						// Keep the previous payload while re-reading so a refresh does not
						// blank the strip mid-flight.
						setState((prev) => ({ ...prev, phase: "loading", error: void 0 }));
					}
					try {
						const payload = await loadRef.current(sessionId);
						if (id !== requestId.current) return;
						// A poll that returns exactly what is already on screen must not
						// re-render: every 15 s of identical data would otherwise rebuild
						// the row, invalidate the memo, and repaint for nothing.
						setState((prev) =>
							options?.silent === true && samePayload(prev.payload, payload)
								? prev
								: { phase: "ready", payload },
						);
					} catch (error) {
						if (id !== requestId.current) return;
						// A thrown load must be visible: the strip exists to remove blind
						// spots, so a silent failure would defeat its only purpose. A failed
						// poll keeps the last good payload and states the failure.
						setState((prev) => ({ ...prev, phase: "failed", error: describeError(error) }));
					} finally {
						inFlight.current = false;
						// If a call arrived while this read was in flight, run it now.
						if (rerunPending.current) {
							rerunPending.current = false;
							void run(options);
						}
					}
				},
				[sessionId],
			);

			React.useEffect(() => {
				void run();
			}, [run, sessionId]);

			// The registry is read live, not watched: DSH emits `tools/change` on the
			// Host, but forwarding it to the browser needs a Typert Remote Event
			// declaration, which is a much larger change than this strip warrants.
			// Polling keeps the MCP answer honest without that machinery.
			React.useEffect(() => {
				if (sessionId === void 0) return void 0;
				let timer;
				const tick = () => {
					// A hidden tab has no reader: skip the read entirely and pick up
					// again on the next visible tick.
					if (document.visibilityState === "visible") void run({ silent: true });
				};
				timer = setInterval(tick, POLL_INTERVAL_MS);
				// Returning to the tab re-reads immediately instead of waiting a full
				// interval, so the answer is current when the reader looks at it.
				const onVisible = () => {
					if (document.visibilityState === "visible") void run({ silent: true });
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [run, sessionId]);

			const payload = state.payload;
			const skillCount = payload?.skills?.entries?.length;
			const mcpRows = payload?.mcpRows ?? [];
			// The answer the whole MCP mark exists for: does at least one MCP server
			// have a tool registered RIGHT NOW? A server that failed to connect
			// registers none, so this is real connectivity, not configuration.
			// Memoized because the dock re-renders on every composer keystroke.
			const connectedServers = React.useMemo(
				() => payload?.tools?.servers ?? [],
				[payload],
			);
			const connected = connectedServers.length > 0;
			// Total MCP tools across all connected servers — the number the chip
			// shows when connected (the icon already says "connected").
			const totalMcpTools = connectedServers.reduce(
				(sum, server) => sum + (server.tools?.length ?? 0),
				0,
			);

			// A fault, not merely an absence: MCP was CONFIGURED AND ENABLED, and yet
			// nothing registered a tool. That is the case worth interrupting the reader
			// for — it means servers that should work are not working, and the failure
			// is otherwise invisible (it only reaches the Host log).
			//
			// A profile with no MCP rows, or with every row disabled, is NOT a fault:
			// nagging about a feature the reader does not use would be noise, and noise
			// gets the plugin uninstalled. A failed registry read is also not a fault
			// claim — the strip cannot tell, so it must not accuse.
			const enabledMcpRows = mcpRows.filter((row) => row.enabled);
			// A row is "settled" only when its Loader lifecycle reached a terminal
			// state: `active` (it should have registered tools) or `failed` (it could
			// not). Everything else — `pending`, `loading`, `null` (disposed), and
			// `unloading` — is mid-lifecycle or gone, and declaring a fault while a
			// row is not settled would be a false alarm.
			const stillConnecting = !enabledMcpRows.every(
				(row) => row.fiberPhase === "active" || row.fiberPhase === "failed",
			);
			const mcpFault =
				payload !== void 0 &&
				payload.tools?.error === void 0 &&
				enabledMcpRows.length > 0 &&
				!stillConnecting &&
				connectedServers.length === 0;

			// Pop the dialog the first time a fault is observed, and again only when the
			// set of affected servers changes. The identity is the sorted row ids, so a
			// recurring fault after a recovery still speaks up.
			const faultKey = mcpFault
				? enabledMcpRows
						.map((row) => rowLabel(row.entryId))
						.sort()
						.join("|")
				: void 0;
			React.useEffect(() => {
				if (faultKey === void 0) return;
				if (acknowledgedFault.current === faultKey) return;
				acknowledgedFault.current = faultKey;
				setAlertOpen(true);
			}, [faultKey]);
			// When the fault clears, close the dialog and reset the dismissal state so
			// the next occurrence of the same fault speaks up again. Without this,
			// `alertOpen` stays true across the Modal's unmount/remount and the dialog
			// would pop open with no user action.
			React.useEffect(() => {
				if (!mcpFault) {
					setAlertOpen(false);
					acknowledgedFault.current = void 0;
				}
			}, [mcpFault]);

			// Two independent marks, never merged into one count. Each distinguishes
			// three states on purpose: not-read-yet (…), failed (读取失败), and a real
			// answer. Collapsing the first two into "0"/"无" would report a fact the
			// strip has not observed.
			const renderSkillChip = () => {
				const skills = payload?.skills;
				let body;
				if (skills?.error !== void 0) body = h(ui.Tag, { tone: "danger" }, "读取失败");
				else if (skillCount === void 0) body = h("span", MUTED, "…");
				else body = h("span", COUNT, String(skillCount));
				return h(
					"span",
					{ style: { display: "flex", alignItems: "center", gap: 3, minWidth: 0 } },
					h(ui.IconSkillOutlineRegular, { size: 12 }),
					h("span", { style: { fontSize: 11, opacity: 0.7 } }, "skill"),
					body,
				);
			};

			const renderMcpChip = () => {
				let body;
				if (payload === void 0) body = h("span", MUTED, "…");
				else if (payload.tools?.error !== void 0)
					body = h(
						"span",
						{ style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)" } },
						"读取失败",
					);
				else
					body = h(
						"span",
						{
							// Colour carries the answer; the word repeats it for anyone who
							// cannot rely on colour alone. A fault is red, not amber: amber
							// reads as "not configured", red as "configured and broken".
							style: {
								display: "flex",
								alignItems: "center",
								gap: 3,
								fontSize: 11,
								color: connected
									? "var(--dsw-alias-state-success-primary)"
									: mcpFault
										? "var(--dsw-alias-state-error-primary)"
										: "var(--dsw-alias-state-warn-primary)",
							},
						},
						h(connected ? ui.IconCheckCircleOutlineRegular : ui.IconCloseOutlineRegular, {
							size: 12,
						}),
						connected ? String(totalMcpTools) : mcpFault ? "连接故障" : "未连接",
					);
				const label = h(
					"span",
					{ style: { display: "flex", alignItems: "center", gap: 3, minWidth: 0 } },
					h(ui.IconGlobeOutlineRegular, { size: 12 }),
					h("span", { style: { fontSize: 11, opacity: 0.7 } }, "MCP"),
					body,
				);
				// A fault is the one case where the mark must be actionable: clicking it
				// re-opens the explanation, so a reader who dismissed the dialog can get
				// it back without hunting for it.
				if (!mcpFault) return label;
				return h(
					"button",
					{
						type: "button",
						onClick: (event) => {
							event.stopPropagation();
							setAlertOpen(true);
						},
						title: "MCP 连接故障：点击查看原因",
						"aria-label": "MCP 连接故障：点击查看原因",
						style: {
							display: "flex",
							alignItems: "center",
							gap: 3,
							minWidth: 0,
							padding: 0,
							border: "none",
							background: "none",
							font: "inherit",
							color: "inherit",
							cursor: "pointer",
						},
					},
					label,
				);
			};

			const skillsSection = (() => {
				// Collapsed, these trees are never mounted, and the dock re-renders on
				// every composer keystroke: skip the work instead of building it unused.
				if (!open || payload === void 0) return null;
				const { skills } = payload;
				return h(
					"div",
					null,
					h(GroupHeading, {
						icon: h(ui.IconSkillOutlineRegular, { size: 13 }),
						name: "技能",
						count: skills.entries?.length,
						note: "本会话可见",
					}),
					skills.error !== void 0
						? h(
								"div",
								{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
								`skills/list 读取失败：${skills.error}`,
							)
						: (skills.entries?.length ?? 0) === 0
							? h(
									"div",
									{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
									"该会话没有可见技能。",
								)
							: skills.entries.map((entry) =>
									h(SkillRow, { key: `${entry.name}:${entry.path ?? ""}`, entry }),
								),
				);
			})();

			const mcpSection = (() => {
				// Collapsed, these trees are never mounted, and the dock re-renders on
				// every composer keystroke: skip the work instead of building it unused.
				if (!open || payload === void 0) return null;
				const { inventory, tools } = payload;
				return h(
					"div",
					null,
					h(GroupHeading, {
						icon: h(ui.IconGlobeOutlineRegular, { size: 13 }),
						name: "MCP",
						count: connectedServers.length,
						note: connected ? `${totalMcpTools} 个工具` : "未连接",
					}),
					// The connected list is the answer to "does it actually work":
					// these servers have tools registered in the live registry.
					tools.error !== void 0
						? h(
								"div",
								{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
								`工具清单读取失败：${tools.error}`,
							)
						: connectedServers.length === 0
							? h(
									"div",
									{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
									"没有 MCP 服务器注册工具——即当前没有连上的服务器。",
								)
							: connectedServers.map((server) =>
									h(
										"div",
										{ key: server.server, style: { padding: "3px 0" } },
										h(
											"div",
											{ style: { display: "flex", alignItems: "center", gap: 6 } },
											h(ui.IconCheckCircleOutlineRegular, {
												size: 13,
												style: { color: "var(--dsw-alias-state-success-primary)" },
											}),
											h("span", { style: { fontSize: 12, fontWeight: 600 } }, server.server),
											h(
												"span",
												{ style: { marginLeft: "auto", fontSize: 11, opacity: 0.65 } },
												`${server.tools.length} 个工具`,
											),
										),
										server.tools.length > 0
											? h(
													"div",
													{
														style: {
															paddingLeft: 19,
															fontSize: 11,
															opacity: 0.55,
															lineHeight: 1.6,
															wordBreak: "break-all",
														},
													},
													server.tools.join("、"),
												)
											: null,
									),
								),
					// Configured rows the Loader carries, shown apart so a configured
					// server with no tools is visible as exactly that.
					inventory.error !== void 0
						? h(
								"div",
								{ style: { fontSize: 11.5, opacity: 0.7, padding: "6px 0 0" } },
								`Loader 条目读取失败：${inventory.error}`,
							)
						: mcpRows.length === 0
							? null
							: h(
									"div",
									null,
									h(
										"div",
										{ style: { fontSize: 11, opacity: 0.6, padding: "8px 0 2px" } },
										`已配置 ${mcpRows.length} 个客户端条目：`,
									),
									mcpRows.map((row) => h(McpRow, { key: row.entryId, row })),
								),
					// The resource plugin decides whether configured servers expose
					// readable resources at all, so its absence is information.
					payload.mcpResources == null
						? null
						: h(
								"div",
								{ style: { fontSize: 11.5, opacity: 0.7, padding: "5px 0 0" } },
								`资源工具：${payload.mcpResources?.enabled ? "已挂载" : "已禁用"}（${rowLabel(payload.mcpResources?.entryId)}）`,
							),
					h(
						"div",
						{ style: { fontSize: 11, opacity: 0.6, lineHeight: 1.5, paddingTop: 5 } },
						"判据是工具注册表里存在 mcp__<server>__* 工具，每 15 秒自动重读一次（页面可见时）。",
						"连不上、或连上但没暴露工具的服务器，都算未连接——两种情况下它的工具都用不了。",
					),
				);
			})();

			const bundlesSection = (() => {
				// Collapsed, these trees are never mounted, and the dock re-renders on
				// every composer keystroke: skip the work instead of building it unused.
				if (!open || payload === void 0) return null;
				// A failed read states its reason like the other two groups; hiding the
				// block would read as "no bundles" and defeat the panel's purpose.
				if (payload.bundles?.error !== void 0) {
					return h(
						"div",
						null,
						h(GroupHeading, {
							icon: h(ui.IconCordisPluginOutlineRegular, { size: 13 }),
							name: "插件包",
						}),
						h(
							"div",
							{ style: { fontSize: 11.5, opacity: 0.7, padding: "4px 0" } },
							`pluginManager/listBundles 读取失败：${payload.bundles?.error}`,
						),
					);
				}
				const enabled = (payload.bundles?.bundles ?? []).filter((bundle) => bundle.enabled);
				return h(
					"div",
					null,
					h(GroupHeading, {
						icon: h(ui.IconCordisPluginOutlineRegular, { size: 13 }),
						name: "插件包",
						count: enabled.length,
						note: "profile 已启用",
					}),
					enabled.map((bundle) =>
						h(
							"div",
							{
								key: bundle.name,
								style: { display: "flex", alignItems: "center", gap: 6, padding: "4px 0" },
							},
							h("span", { style: { fontSize: 12 } }, bundle.name),
							h("span", { style: { marginLeft: "auto", fontSize: 11, opacity: 0.6 } }, `${bundle.version ?? "-"} · ${bundle.rows?.length ?? 0} rows`),
						),
					),
				);
			})();

			return h(
				"div",
				{
					// This ref is the anchor the floating detail panel positions itself
					// against. It MUST be on a DOM node: without it `anchorRef.current`
					// stays null, `place()` returns before setting `pos`, and the panel
					// renders permanently `visibility: hidden`.
					ref: anchorRef,
					style: {
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 2,
						padding: "2px 0",
						// Content width, never `100%`: the composer dock is a shared flex row
						// and a full-width claim here would push every sibling widget and
						// leave the strip's own content off to the side.
						flex: "0 1 auto",
						minWidth: 0,
					},
				},
				// The whole row is the toggle: clicking anywhere in the strip opens or
				// closes the detail panel. No separate icon button needed.
				h(
					"div",
					{
						role: "button",
						tabIndex: 0,
						"aria-expanded": open,
						"aria-label": open ? "收起明细" : "展开明细",
						title: open ? "收起明细" : "明细",
						onClick: () => setOpen((prev) => !prev),
						onMouseDown: (event) => event.stopPropagation(),
						style: {
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							gap: 5,
							minHeight: 22,
							flexWrap: "nowrap",
							maxWidth: "100%",
							cursor: "pointer",
						},
					},
					renderSkillChip(),
					h("span", { style: { height: 10, display: "flex" } }, h(Divider, { vertical: true })),
					renderMcpChip(),
				),
				state.phase === "failed"
					? h(
							"div",
							{ style: { fontSize: 11.5, opacity: 0.75, padding: "2px 0" } },
							`读取失败：${state.error}`,
						)
					: null,
				// The detail floats above the page instead of pushing it: a fixed panel
				// anchored to this row. It is portalled to <body> so no ancestor's
				// overflow or stacking context can clip it. `document.body` is checked
				// because the portal target must exist before React can mount into it.
				open && payload !== void 0 && document.body !== null && document.body !== void 0
					? ReactDOM.createPortal(
							h(DetailPanel, {
								anchorRef,
								onClose: () => setOpen(false),
								loadedAt: payload.loadedAt,
								loading: state.phase === "loading",
								onRefresh: () => void run(),
								children: [
									h("div", { key: "skills" }, skillsSection),
									h("div", { key: "s1", style: { height: 10 } }),
									h("div", { key: "mcp" }, mcpSection),
									h("div", { key: "s2", style: { height: 10 } }),
									h("div", { key: "bundles" }, bundlesSection),
								],
							}),
							document.body,
						)
					: null,
				// The fault dialog. It is the one interruption this strip is allowed to
				// make, and only for a real fault: MCP was configured and enabled, and
				// nothing registered a tool. `ui.Modal` is the shipped component, so
				// focus trapping, the mask, Escape, and the portal are its behaviour, not
				// something re-implemented here.
				mcpFault
					? h(
							ui.Modal,
							{
								open: alertOpen,
								onClose: () => setAlertOpen(false),
								title: "MCP 连接故障",
								closeLabel: "关闭",
								footer: h(
									ui.Button,
									{
										variant: "primary",
										size: "sm",
										onClick: () => setAlertOpen(false),
									},
									"知道了",
								),
							},
							h(
								"div",
								{ style: { display: "flex", flexDirection: "column", gap: 8, fontSize: 12.5 } },
								h(
									"div",
									{ style: { lineHeight: 1.6 } },
									`有 ${enabledMcpRows.length} 个已启用的 MCP 客户端，但没有任何一个注册了工具。`,
									"这意味着它们的工具现在全部不可用。",
								),
								h(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: 3 } },
									enabledMcpRows.map((row) =>
										h(
											"div",
																					{
												key: row.entryId,
												style: {
													display: "flex",
													alignItems: "center",
													gap: 6,
													fontSize: 12,
												},
											},
											h(ui.IconWarningOutlineRegular, {
												size: 13,
												style: { color: "var(--dsw-alias-state-error-primary)" },
											}),
											h("span", { style: { fontWeight: 600 } }, rowLabel(row.entryId)),
											h(
												"span",
												{ style: { marginLeft: "auto", opacity: 0.6, fontSize: 11 } },
												row.fiberPhase ?? "无状态",
											),
										),
									),
								),
								h(
									"div",
									{ style: { opacity: 0.7, lineHeight: 1.6, fontSize: 11.5 } },
									"常见原因：服务器进程没起来、地址或鉴权配置错误、连接在启动后掉线。",
									"具体报错只写在宿主日志里，页面上拿不到——这是 DSH 目前的限制。",
								),
							),
						)
					: null,
			);
		}

		/**
		 * The floating detail panel. Positioned above its anchor row and portalled to
		 * <body>, so opening it never changes the composer's height.
		 * @param props - anchor ref, close/refresh callbacks, and the sections.
		 */
		function DetailPanel({ anchorRef, onClose, loadedAt, loading, onRefresh, children }) {
			const [pos, setPos] = React.useState(null);
			const panelRef = React.useRef(null);
			// `onClose` is a new function on every parent render. Holding it in a ref
			// keeps the outside-click effect from tearing down and re-adding its
			// listener on every render (a gap during which a mousedown could slip
			// through unnoticed).
			const onCloseRef = React.useRef(onClose);
			React.useEffect(() => {
				onCloseRef.current = onClose;
			}, [onClose]);

			// Place the panel from the anchor's live rect on open, and keep it placed
			// while the window resizes. `fixed` keeps it put when the page scrolls.
			// The panel opens upward, so a short viewport is clamped by height rather
			// than pushing its top off screen.
			React.useEffect(() => {
				const place = () => {
					const anchor = anchorRef.current;
					if (anchor === null) return;
					const rect = anchor.getBoundingClientRect();
					const width = Math.min(480, window.innerWidth - 24);
					const left = Math.max(
						12,
						Math.min(
							rect.left + rect.width / 2 - width / 2,
							window.innerWidth - width - 12,
						),
					);
					const maxHeight = Math.max(
						120,
						Math.min(window.innerHeight * 0.6, 420, rect.top - 18),
					);
					setPos({ left, width, maxHeight, bottom: window.innerHeight - rect.top + 6 });
				};
				place();
				window.addEventListener("resize", place);
				return () => window.removeEventListener("resize", place);
			}, [anchorRef]);

			// Escape closes it. Capture phase plus stopPropagation keeps the composer's
			// own Escape handling from also firing while the panel is open. If the
			// fault Modal is also open, defer to it: it portals to <body> and owns
			// Escape as its dismissal key.
			React.useEffect(() => {
				const onKey = (event) => {
					if (event.key !== "Escape") return;
					// `aria-modal` distinguishes the fault Modal from this panel (which
					// is also `role="dialog"` but not modal).
					if (document.querySelector('[role="dialog"][aria-modal]')) return;
					event.stopPropagation();
					onCloseRef.current();
				};
				window.addEventListener("keydown", onKey, true);
				return () => window.removeEventListener("keydown", onKey, true);
			}, []);

			// A click anywhere outside the panel closes it, like every other popover.
			// `mousedown` rather than `click`: a drag that starts inside and ends
			// outside (text selection) must not be read as an outside click. The
			// toggle button is excluded so pressing it once collapses the panel
			// instead of closing here and immediately reopening on that button's own
			// click.
			React.useEffect(() => {
				const onDown = (event) => {
					const panel = panelRef.current;
					if (panel === null) return;
					const target = event.target;
					if (panel.contains(target)) return;
					const anchor = anchorRef.current;
					if (anchor !== null && anchor.contains(target)) return;
					// Clicks inside the fault Modal must not close this panel: the Modal
					// portals to <body> and its mask/buttons are outside the anchor.
					if (target.closest?.('[role="dialog"][aria-modal]')) return;
					onCloseRef.current();
				};
				window.addEventListener("mousedown", onDown);
				return () => window.removeEventListener("mousedown", onDown);
			}, [anchorRef]);

			return h(
				"div",
				{
					ref: panelRef,
					role: "dialog",
					"aria-label": "能力明细",
					style: {
						position: "fixed",
						// Nothing is painted until the anchor has been measured, so the
						// panel never flashes at the wrong corner.
						...(pos === null ? { visibility: "hidden", top: 0, left: 0 } : pos),
						width: pos === null ? 480 : pos.width,
						maxHeight: pos === null ? 420 : pos.maxHeight,
						display: "flex",
						flexDirection: "column",
						gap: 2,
						padding: "8px 10px",
						zIndex: 60,
						background: "var(--dsw-alias-bg-layer-1, #fff)",
						color: "inherit",
						border: "1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))",
						borderRadius: "var(--dsw-radius-lg, 12px)",
						boxShadow: "0 10px 30px rgba(0, 0, 0, 0.14)",
						fontSize: 12,
					},
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 6 } },
					h(
						"span",
						{ style: { fontSize: 11, opacity: 0.6 } },
						loadedAt !== void 0 ? `读取于 ${loadedAt}` : "尚未记录读取时间",
					),
					h(
						"span",
						{ style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 } },
						h(
							ui.Button,
							{
								variant: "ghost",
								size: "sm",
								onClick: onRefresh,
								disabled: loading,
								"aria-label": "刷新能力信息",
								title: "重新读取",
							},
							h(ui.IconRefreshOutlineRegular, { size: 12 }),
						),
						h(
							ui.Button,
							{
								variant: "ghost",
								size: "sm",
								onClick: onClose,
								"aria-label": "关闭明细",
								title: "关闭",
							},
							h(ui.IconCloseOutlineRegular, { size: 12 }),
						),
					),
				),
				h(Divider, null),
				h("div", { style: { overflowY: "auto", minHeight: 0 } }, children),
			);
		}

		/**
		 * Client plugin body: dock the strip under the composer, in the same bar the
		 * `dsh-persona-dafeiyu` plugin uses.
		 *
		 * `conversation.input.dock` renders INSIDE the composer stack but BEFORE the
		 * input bar, so anything there sits above the box the reader types in.
		 * `conversation.composer.dock` is a child of the input bar's own dock element,
		 * which the bar renders after its input row — under the box.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const remote = ctx.remote;
			// `connection` is provided by the shipped client-connection plugin at
			// runtime (`ctx.provide("connection", handle)`), which is how the strip
			// reaches its own host half. Cordis gates the read behind the declared
			// name in `inject`.
			const connection = ctx.connection;
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{
						name: "conversation.composer.dock",
						id: "ability-strip",
						// The persona bar registers at 60; 65 keeps this strip directly
						// beneath it instead of depending on registration tie-breaking.
						order: 65,
						// `load` takes the session id as an argument rather than closing over
						// the inject face's one: the component already receives the session id
						// as a built-in standard prop, and that is the value it must read.
						inject: () => ({
							load: (sessionId) => loadAll(remote, sessionId, connection),
						}),
					},
					RuntimeStrip,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
