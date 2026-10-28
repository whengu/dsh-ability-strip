/**
 * Host-half checks: the `mcp__<server>__<tool>` split, the per-server summary, and
 * the route registration contract.
 *
 * The MCP tool naming rule is the load-bearing assumption of the whole feature, so
 * it is pinned here against real registry shapes rather than assumed.
 */

import { apply, inject, name, ROUTE_CHANNEL, ROUTE_ENDPOINT, readToolSummary, splitMcpToolName, summarizeMcpTools } from "../lib/index.js";

const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

// --- splitMcpToolName -----------------------------------------------------
check(splitMcpToolName("mcp__local__read_file")?.server === "local", "plain mcp tool must yield its server");
check(splitMcpToolName("mcp__local__read_file")?.tool === "read_file", "plain mcp tool must yield its tool");
check(splitMcpToolName("read_file") === undefined, "a non-prefixed tool is not an MCP tool");
check(splitMcpToolName("mcp__") === undefined, "a bare prefix carries no server");
check(splitMcpToolName("mcp____tool") === undefined, "an empty server part is rejected");
check(splitMcpToolName(undefined) === undefined, "a non-string name is rejected");

// A server whose own name contains `__`: the split must be at the LAST separator,
// otherwise `my__server` would be read as server `my` and tool `server__tool`.
const nested = splitMcpToolName("mcp__my__server__tool");
check(nested?.server === "my__server", "server names containing __ must survive the split");
check(nested?.tool === "tool", "the tool part is whatever follows the last separator");

// --- summarizeMcpTools ----------------------------------------------------
const summary = summarizeMcpTools([
  { name: "mcp__local__read_file" },
  { name: "mcp__local__write_file" },
  { name: "mcp__remote__search" },
  { name: "read" },
  { name: "bash" },
]);
check(summary.length === 2, "two servers must be reported");
check(summary[0].server === "local" && summary[0].tools.length === 2, "local must carry its two tools");
check(summary[1].server === "remote" && summary[1].tools[0] === "search", "remote must carry its one tool");
check(
  summary.every((entry) => entry.server !== "read" && entry.server !== "bash"),
  "built-in tools must never be counted as MCP servers",
);
check(summarizeMcpTools([]).length === 0, "an empty registry reports no servers");
check(summarizeMcpTools(undefined).length === 0, "a missing registry reports no servers");

// --- readToolSummary ------------------------------------------------------
const okSummary = readToolSummary({ tools: { schemas: () => [{ name: "mcp__local__x" }, { name: "read" }] } });
check(okSummary.ok === true, "a working registry must succeed");
check(okSummary.totalTools === 2, "every tool counts toward totalTools");
check(okSummary.servers.length === 1 && okSummary.servers[0].server === "local", "only the MCP server is summarized");
check(typeof okSummary.readAt === "string", "a read timestamp must be present");

const failedSummary = readToolSummary({
  tools: {
    schemas() {
      throw new Error("registry exploded");
    },
  },
});
check(failedSummary.ok === false, "a throwing registry must report failure");
check(failedSummary.error === "registry exploded", "the failure must carry the real message");

// --- apply: route registration -------------------------------------------
const registered = [];
const disposed = [];
// The registry is counted so the cache can be proven: `schemas()` deep-clones
// every tool, so it must NOT run once per poll.
let schemasCalls = 0;
const changeListeners = [];
const fakeCtx = {
  tools: {
    schemas: () => {
      schemasCalls += 1;
      return [{ name: "mcp__local__read_file" }];
    },
  },
  on(event, listener) {
    if (event === "tools/change") changeListeners.push(listener);
    return () => {
      const index = changeListeners.indexOf(listener);
      if (index >= 0) changeListeners.splice(index, 1);
    };
  },
  effect(callback) {
    const disposer = callback();
    // Cordis owns this disposer; the check drives it to prove unload cleanup.
    fakeCtx.effectDisposer = disposer;
    return disposer;
  },
  connection: {
    fetch: {
      register(route) {
        registered.push(route);
        return async () => {
          disposed.push(route.path);
        };
      },
    },
  },
};

apply(fakeCtx);
check(registered.length === 1, "apply must register exactly one route");
const route = registered[0];
check(route.path === `${ROUTE_CHANNEL}/${ROUTE_ENDPOINT}`, "the route path must be channel/endpoint");
check(route.path.startsWith("/api/"), "the route must sit below the shared /api channel");
check(Array.isArray(route.methods) && route.methods.length === 1 && route.methods[0] === "POST", "rpc.call always POSTs, so the route is POST-only");
check(route.requestBody === "buffered", "the route takes a buffered body");
check(typeof route.fetch === "function", "the route must expose a fetch handler");

// The handler must speak the carrier's client-request envelope, not a bare GET.
const envelopeRequest = new Request("http://localhost" + route.path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "client-request", rpcId: "rpc-1", payload: { action: "tools", data: null } }),
});
const response = await route.fetch(envelopeRequest);
check(response instanceof Response, "the handler must answer with a Response");
const envelope = await response.json();
check(envelope.type === "server-response", "the reply must use the carrier's server-response envelope");
check(envelope.rpcId === "rpc-1", "the reply must echo the request rpcId");
check(envelope.result?.ok === true, "the served result must report success");
check(Array.isArray(envelope.result?.value?.servers), "the served value must carry a server list");

// A body that is not a client-request envelope must be rejected, not guessed at.
const badResponse = await route.fetch(
  new Request("http://localhost" + route.path, { method: "POST", body: "not json" }),
);
check(badResponse.status === 400, "an unparseable body must be rejected with 400");

// --- the cache: poll cost must not scale with the catalog ----------------
// `schemas()` deep-clones every visible tool. A poll must therefore hit the cache,
// not the registry: otherwise four polls a minute would copy the whole catalog.
const callsAfterFirstRead = schemasCalls;
check(callsAfterFirstRead === 1, `the first read must call schemas() once, saw ${callsAfterFirstRead}`);
await route.fetch(
  new Request("http://localhost" + route.path, {
    method: "POST",
    body: JSON.stringify({ type: "client-request", rpcId: "rpc-2", payload: { action: "tools", data: null } }),
  }),
);
check(schemasCalls === callsAfterFirstRead, `a repeat poll must not touch the registry, saw ${schemasCalls} calls`);

// `tools/change` is the exact invalidation: after it, the next read is fresh.
check(changeListeners.length === 1, "apply must subscribe to tools/change exactly once");
changeListeners[0]();
await route.fetch(
  new Request("http://localhost" + route.path, {
    method: "POST",
    body: JSON.stringify({ type: "client-request", rpcId: "rpc-3", payload: { action: "tools", data: null } }),
  }),
);
check(schemasCalls === callsAfterFirstRead + 1, `a tools/change must invalidate the cache, saw ${schemasCalls} calls`);

// Unloading must drop the listener, or a dead row keeps watching a live service.
// `apply` hands its disposer to Cordis through `ctx.effect`; drive it directly.
const effectDisposer = fakeCtx.effectDisposer;
check(typeof effectDisposer === "function", "apply must register one effect");
await effectDisposer();
check(changeListeners.length === 0, "unloading must drop the tools/change listener");
check(disposed.length === 1, "unloading must dispose the route");

check(name === "ability-strip", "the plugin id must stay stable");
check(Array.isArray(inject) && inject.includes("connection") && inject.includes("tools"), "inject must name both services");

console.log("--- host half ---");
console.log("servers:", JSON.stringify(summary));
console.log("route:", route.path, JSON.stringify(route.methods));
console.log("schemas() calls after 3 reads + 1 change:", schemasCalls);
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const problem of problems) console.log("  - " + problem);
  console.log("RESULT: FAIL");
  process.exitCode = 1;
} else {
  console.log("RESULT: PASS");
}
