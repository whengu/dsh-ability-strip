/**
 * Host half of dsh-ability-strip.
 *
 * The browser can read the skill catalog and the Loader inventory on its own, but
 * it has **no** way to see the tool registry: which tools are actually registered,
 * and therefore whether each configured MCP server really connected. A server
 * that fails to connect registers no `mcp__<server>__*` tools, so the registry is
 * the only browser-visible evidence of a live MCP connection.
 *
 * This half answers exactly that one question and nothing else:
 *
 *   - read `ctx.tools.schemas()`, split the names on the `mcp__<server>__<tool>`
 *     convention the MCP client itself uses, and count tools per server;
 *   - serve the result on one exact, owner-only Connection route.
 *
 * It is read-only: it registers no tool, mutates no registry, edits no config, and
 * holds no state between requests. There is nothing to synchronize and nothing to
 * dispose beyond the route itself.
 *
 * @module dsh-ability-strip
 */

/** Stable plugin id for the Loader row. */
export const name = "ability-strip";

/**
 * Services this half waits for. `connection` provides the owner-only Fetch route
 * registry; `tools` is the registry being read. Declaring both keeps activation
 * behind real availability instead of failing on first use.
 */
export const inject = ["connection", "tools"];

/** Carrier channel: the shared `/api` route the Connection mounts itself. */
export const ROUTE_CHANNEL = "/api";

/**
 * Endpoint this plugin owns inside that channel. `connection.rpc.call` posts to
 * `<channel>/<endpoint>`, so this value and the client's must stay identical.
 */
export const ROUTE_ENDPOINT = "ability-strip";

/** Prefix the MCP client puts on every tool it registers. */
const MCP_TOOL_PREFIX = "mcp__";

/**
 * Split an MCP tool name into its server and tool parts.
 *
 * The MCP client names tools `mcp__<server>__<tool>`. This is a **heuristic**
 * reverse of that convention: the harness never parses the public name back
 * (`dsh-mcp-client` documents "the public name is never parsed to recover it"),
 * so there is no authoritative rule to mirror. The split at the **last**
 * separator handles server names that themselves contain `__`. Known limitation:
 * a tool whose raw name contains `__` is ambiguous and may be attributed to the
 * wrong server.
 * @param toolName - a registered tool name.
 * @returns the server name and tool name, or undefined for a non-MCP tool.
 */
export function splitMcpToolName(toolName) {
	if (typeof toolName !== "string" || !toolName.startsWith(MCP_TOOL_PREFIX)) {
		return void 0;
	}
	const separator = toolName.lastIndexOf("__");
	// A separator at or before the prefix means the name carries no server part.
	if (separator <= MCP_TOOL_PREFIX.length - 1) return void 0;
	const server = toolName.slice(MCP_TOOL_PREFIX.length, separator);
	if (server.length === 0) return void 0;
	const tool = toolName.slice(separator + 2);
	return { server, tool };
}

/**
 * Group the registry's tool names into per-server MCP counts.
 *
 * A server appears here only because at least one of its tools is registered
 * right now. That is deliberately the ONLY evidence used: `dsh-mcp-client` keeps
 * its connection object (`ready`, `connectedAt`, the retry supervisor) private,
 * so a server that connected successfully but exposes **no** tools is
 * indistinguishable from one that never connected — both register nothing.
 * The strip therefore reports both as not connected, which is the safe reading:
 * a server whose tools are unavailable is not usable even if its socket is up.
 * @param schemas - model-facing tool schemas from `ctx.tools.schemas()`.
 * @returns one entry per server with a registered tool, sorted by name.
 */
export function summarizeMcpTools(schemas) {
	/** @type {Map<string, string[]>} */
	const byServer = new Map();
	for (const schema of Array.isArray(schemas) ? schemas : []) {
		const split = splitMcpToolName(schema?.name);
		if (split === void 0) continue;
		const tools = byServer.get(split.server);
		if (tools === void 0) byServer.set(split.server, [split.tool]);
		else tools.push(split.tool);
	}
	return [...byServer.entries()]
		.map(([server, tools]) => ({ server, tools: tools.sort() }))
		.sort((left, right) => (left.server < right.server ? -1 : left.server > right.server ? 1 : 0));
}

/**
 * Read the live tool registry and summarize it.
 *
 * Never throws: a registry read failure becomes `error`, so the browser can state
 * the failure instead of silently reporting "no MCP tools".
 * @param ctx - Host context providing `tools`.
 * @returns the summary, or a diagnostic instead of a throw.
 */
export function readToolSummary(ctx) {
	try {
		const schemas = ctx.tools.schemas();
		const servers = summarizeMcpTools(schemas);
		return {
			ok: true,
			totalTools: Array.isArray(schemas) ? schemas.length : 0,
			servers,
			readAt: new Date().toISOString(),
		};
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Wrap {@link readToolSummary} in a cache invalidated by the registry itself.
 *
 * `ctx.tools.schemas()` deep-clones every visible tool, so calling it on each poll
 * would copy the whole catalog four times a minute for an answer that almost never
 * changes. The Host already knows when the answer changes: it emits `tools/change`
 * on every registration, unregistration, and scoped restriction. Hooking that
 * event makes the cache exact — it is dropped precisely when it could be stale,
 * never on a timer.
 * @param ctx - Host context providing `tools`.
 * @returns a reader returning the current summary, and its disposer.
 */
export function createToolSummaryReader(ctx) {
	let cached;
	const invalidate = () => {
		cached = void 0;
	};
	const off = ctx.on("tools/change", invalidate);
	return {
		read() {
			// Cache only successful reads. A transient failure (registry not yet
			// ready, a momentary error) must not stick: the next poll should retry,
			// not keep serving the stale error until the next `tools/change`.
			if (cached !== void 0) return cached;
			const result = readToolSummary(ctx);
			if (result.ok) cached = result;
			return result;
		},
		dispose() {
			off();
		},
	};
}

/**
 * Plugin body: register the one route the browser calls.
 *
 * The route speaks the shared `/api` carrier's client-request envelope, which is
 * what `connection.rpc.call(channel, endpoint, payload)` puts on the wire:
 *
 *   request   { type: 'client-request',  rpcId, payload: { action, data } }
 *   response  { type: 'server-response', rpcId, result }
 *
 * where `result` is `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 * @param ctx - Host context.
 */
export function apply(ctx) {
	ctx.effect(() => {
		// One reader per Loader row, cached and invalidated by `tools/change`: the
		// poll then costs nothing until the registry actually moves.
		const reader = createToolSummaryReader(ctx);
		const dispose = ctx.connection.fetch.register({
			path: `${ROUTE_CHANNEL}/${ROUTE_ENDPOINT}`,
			// `rpc.call` always POSTs; the read carries no body of its own.
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				const envelope = await readClientRequest(request);
				if (envelope === void 0) {
					return new Response("invalid client-request envelope", { status: 400 });
				}
				// `readToolSummary` never throws: a registry failure becomes
				// `{ ok: false, error }`, which the browser shows as 读取失败. It is
				// still wrapped because an envelope this plugin cannot see must not
				// become a 500 the browser would report as a transport failure.
				let result;
				try {
					result = { ok: true, value: reader.read() };
				} catch (error) {
					result = {
						ok: false,
						error: {
							code: "internal",
							message: error instanceof Error ? error.message : String(error),
							details: {},
						},
					};
				}
				return Response.json({
					type: "server-response",
					rpcId: envelope.rpcId,
					result,
				});
			},
		});
		// `register` returns an async disposer; Cordis awaits it on unload. The
		// `tools/change` listener must go with it, or an unloaded row would keep a
		// listener on a live service.
		return () => {
			reader.dispose();
			void dispose();
		};
	}, "ability-strip: tool route");
}

/**
 * Extract this plugin's fields from the carrier's client-request envelope.
 * The carrier has already validated transport-level shape.
 * @param request - incoming Fetch API request.
 * @returns the rpc id, or undefined when unparseable.
 */
async function readClientRequest(request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return void 0;
	}
	if (body?.type !== "client-request" || typeof body.rpcId !== "string") return void 0;
	return { rpcId: body.rpcId };
}
