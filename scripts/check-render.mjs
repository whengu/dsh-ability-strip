// Drive the dock component with synthetic Remote answers and assert the tree it
// builds. This executes the component function, not the browser: it verifies the
// render logic (chips, sections, failure copy) without any live page.
//
// Each case is a FRESH MOUNT: hook storage is reset per case so state cannot leak
// between scenarios.
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
/** Package root: this script lives in <root>/scripts. */
const pkgDir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(pkgDir, "lib/client.js"), "utf8");

// A minimal DOM surface: the bundle reads `document.body` as the portal target
// and measures the anchor row. Both are stubbed so the component can be executed
// without a browser; nothing here renders.
const BODY = { nodeType: 1, tagName: "BODY" };
globalThis.document = {
  body: BODY,
  // The strip polls only while the tab is visible.
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};
// The poll timer is captured rather than scheduled: the checks drive the strip
// directly, and a live interval would keep the process alive.
const timers = [];
globalThis.setInterval = (fn, ms) => {
  timers.push({ fn, ms });
  return timers.length;
};
globalThis.clearInterval = () => {};
globalThis.window = {
  __ModuleLoader__: { load(r) { globalThis.__reg = r; } },
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};

const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity),
});

// --- hook runtime ---------------------------------------------------------
let hookState = [];
let hookIndex = 0;
let effects = [];

const React = {
  createElement,
  useState(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = typeof initial === "function" ? initial() : initial;
    const set = (next) => {
      hookState[i] = typeof next === "function" ? next(hookState[i]) : next;
    };
    return [hookState[i], set];
  },
  useRef(initial) {
    const i = hookIndex++;
    if (!(i in hookState)) hookState[i] = { current: initial };
    return hookState[i];
  },
  useCallback(fn) {
    hookIndex++;
    return fn;
  },
  // Recompute every render: the stub has no dependency tracking, and the checks
  // only care about the value, not about referential stability.
  useMemo(fn) {
    hookIndex++;
    return fn();
  },
  useEffect(fn) {
    hookIndex++;
    effects.push(fn);
  },
};

// A primitive stub that PRESERVES children, so text inside Tag/Button survives.
const primitive = (key) => (props, ...children) => ({
  type: key,
  props: props ?? {},
  children: children.flat(Infinity),
});
// `Modal` is the one primitive whose behaviour matters here: a closed dialog
// renders nothing at all. A generic stub would leak its text into every check and
// make "no dialog" impossible to assert.
const stubs = new Proxy(
  {
    Modal: (props, ...children) => {
      if (props?.open !== true) return null;
      return { type: "Modal", props: props ?? {}, children: children.flat(Infinity) };
    },
  },
  {
    get: (target, key) => {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return primitive(key);
    },
  },
);

// `react-dom`'s only use here is createPortal: record the target and return the
// child tree so the panel's contents stay assertable.
const ReactDOM = {
  createPortal(children, container) {
    return { type: "Portal", props: { container }, children: [].concat(children) };
  },
};

new Function("window", "document", source)(globalThis.window, globalThis.document);
const exportsObj = globalThis.__reg.factory((id) =>
  id === "react" ? React : id === "react-dom" ? ReactDOM : stubs,
);

let Component;
exportsObj.apply({
  remote: {},
  slots: {
    inject(_name, register) { register(); return () => {}; },
    register(_options, component) { Component = component; return () => {}; },
  },
});

/** Fresh mount: clears hook storage so no state leaks between cases. */
function mount(props) {
  hookState = [];
  hookIndex = 0;
  effects = [];
  return render(props);
}

/** Re-render the current mount (keeps state, re-runs the component). */
function render(props) {
  hookIndex = 0;
  effects = [];
  return Component(props);
}

/** Flush effects of the current mount. */
async function settle() {
  const pending = [...effects];
  for (const fn of pending) await fn();
  await new Promise((r) => setImmediate(r));
}

/** Collect every string/number leaf in a built tree, expanding function components. */
function textOf(node) {
  if (node === null || node === undefined) return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (typeof node !== "object") return [];
  // A function component has not been invoked yet: call it so its markup counts.
  if (typeof node.type === "function") {
    let out;
    try {
      out = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
    } catch {
      return [];
    }
    return textOf(out);
  }
  return textOf(node.children);
}

/**
 * Depth-first search for an interactive node by label. Matches the rendered text
 * or the accessible name, because the strip's buttons are icon-only.
 */
/**
 * Find the fault dialog in a built tree, if it is open.
 *
 * `h(ui.Modal, ...)` stores the component FUNCTION as `type`, so a node only
 * becomes `type: "Modal"` after the stub runs — and the stub returns `null` while
 * `open` is false. Searching for the rendered string instead would miss the title,
 * which `Modal` takes as a prop rather than a child.
 * @param node - built tree root.
 * @returns the Modal node when the dialog is open, otherwise undefined.
 */
function findDialog(node) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findDialog(child);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node.type === "Modal") return node;
  if (typeof node.type === "function") {
    const produced = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
    if (produced !== null && produced !== undefined && typeof produced === "object") {
      if (produced.type === "Modal") return produced;
      const nested = findDialog(produced);
      if (nested) return nested;
    }
    return undefined;
  }
  return findDialog(node.children);
}

function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label);
      if (hit) return hit;
    }
    return undefined;
  }
  // A portal node holds the panel; its children are not invoked components.
  if (node.type === "Portal") return findButton(node.children, label);
  // A function component must be invoked before its controls can be found.
  if (typeof node.type === "function") {
    let out;
    try {
      out = node.children.length > 0 ? node.type(node.props, ...node.children) : node.type(node.props);
    } catch {
      return undefined;
    }
    return findButton(out, label);
  }
  if (typeof node.props?.onClick === "function") {
    const ownText = textOf(node.children).join("");
    const name = node.props["aria-label"];
    if (ownText.includes(label) || (typeof name === "string" && name.includes(label))) return node;
  }
  return findButton(node.children, label);
}

const problems = [];
const check = (cond, msg) => { if (!cond) problems.push(msg); };
/** Substring test over the collected text leaves (Array#includes is exact). */
const has = (text, needle) => text.some((t) => t.includes(needle));
const log = (label, tree) => console.log(`${label}: ${JSON.stringify(textOf(tree).join(" | "))}`);

const mcpEntry = { entryId: "include:mcp-local", moduleName: "@deepseek-ai/dsh-mcp-client", enabled: true, fiberPhase: "active" };
const resourcesEntry = { entryId: "mcp-resources", moduleName: "@deepseek-ai/dsh-mcp-resources", enabled: true, fiberPhase: "active" };
const payloadOk = {
  skills: { entries: [
    { name: "anti-process-theater", description: "stops theater", modelInvocable: true, whenToUse: "when a subagent flow looks staged" },
    { name: "code-review", description: "review", modelInvocable: false },
  ] },
  inventory: { snapshot: { entries: [mcpEntry, resourcesEntry] } },
  bundles: { bundles: [{ name: "dsh-base", enabled: true, version: "0.2.1-rc.2", rows: [1, 2] }] },
  // What the host half reports: `local` connected with two registered tools.
  tools: { servers: [{ server: "local", tools: ["read_file", "write_file"] }], totalTools: 5 },
  mcpRows: [mcpEntry],
  mcpResources: resourcesEntry,
  loadedAt: "12:00:00",
};
// The resource plugin is mounted once for all servers, so it must never be
// counted or listed as a server.
const payloadNoResources = { ...payloadOk, inventory: { snapshot: { entries: [mcpEntry] } }, mcpResources: null };
// A configured server whose tools never registered: present in the Loader,
// absent from the registry. This is the case 有/无 must get right.
const payloadDisconnected = {
  ...payloadOk,
  tools: { servers: [], totalTools: 3 },
};
const okProps = { sessionId: "s1", load: async () => payloadOk };
const disconnectedProps = { sessionId: "s1", load: async () => payloadDisconnected };

// --- Case 1: first paint, nothing read yet --------------------------------
let tree = mount(okProps);
log("case1 (first paint)", tree);
let text = textOf(tree);
check(text.includes("skill"), "first paint must label skill");
check(text.includes("MCP"), "first paint must label MCP");
check(text.includes("…"), "first paint must show a pending placeholder");
check(!text.includes("未连接"), "first paint must NOT claim MCP is disconnected before reading");
// The strip carries no title word of its own; the two marks name themselves.
check(!text.includes("能力"), "the strip must not print a title word");
check(!text.includes("技能"), "the collapsed row must use the word skill, not 技能");

// --- Case 2: loaded, collapsed -------------------------------------------
await settle();
tree = render(okProps);
log("case2 (loaded, collapsed)", tree);
text = textOf(tree);
check(text.includes("2"), "skill count 2 must render");
check(text.includes("MCP"), "first paint must label MCP");
check(!text.includes("mcp-local"), "the collapsed row must not print server ids");
check(!text.includes("…"), "no placeholder once data arrived");
// MCP is a yes/no answer about the live registry, not a roster.
check(!text.includes("已连接"), "the chip must not repeat the icon state as text");
check(!text.includes("未连接"), "a connected server must not read 未连接");
check(!has(text, "已启用 · "), "the collapsed row must not print Loader phases");
// Collapsed must not build the detail trees: they are skipped for cost, since the
// dock re-renders on every composer keystroke.
check(!has(text, "插件包"), "collapsed must not build the bundles section");
check(!has(text, "anti-process-theater"), "collapsed must not build skill rows");
// Narrow layout guard. The composer dock is a shared flex row, so a full-width
// claim here pushes every sibling widget and pulls the strip off to one side.
const rootStyle = tree.props?.style ?? {};
check(rootStyle.width !== "100%", "the strip wrapper must not claim full width");
check(rootStyle.flex === "0 1 auto", "the strip wrapper must size to its content");
const collapsedExpand = findButton(tree, "展开明细");
check(collapsedExpand !== undefined, "the row must be clickable with an accessible name");
check(
  findButton(tree, "刷新能力信息") === undefined,
  "the collapsed row must not carry a refresh control (it lives in the detail)",
);

// --- Case 3: expanded -----------------------------------------------------
const expand = findButton(tree, "明细");
console.log("expand button found:", expand !== undefined);
check(expand !== undefined, "明细 button must exist");
if (expand) expand.props.onClick();
tree = render(okProps);
log("case3 (expanded)", tree);
text = textOf(tree);
check(has(text, "anti-process-theater"), "expanded must list skill names");
check(has(text, "/anti-process-theater"), "a skill name must render in composer form");
check(has(text, "when a subagent flow looks staged"), "whenToUse must be shown when present");
check(has(text, "code-review"), "expanded must list every skill");
  check(has(text, "已启用 · active"), "expanded MCP row must show its Loader phase");
check(text.includes("dsh-base"), "expanded must list bundle names");
check(text.includes("插件包"), "bundles group must have its own heading");
check(text.includes("技能") && text.includes("MCP"), "both group headings present in the detail");
check(has(text, "资源工具：已挂载"), "the resource plugin must be stated when mounted");
check(findButton(tree, "刷新能力信息") !== undefined, "the detail must offer a refresh control");
// It is mounted once for all servers, so it must never render as a server row:
// a server row is the ONLY place the `enabled · <phase>` label appears.
  const serverRows = text.filter((t) => t.includes("已启用 · ") || t.includes("已停用 · "));
check(serverRows.length === 1, `expected one MCP server row, saw ${serverRows.length}`);
check(
  !text.some((t) => t.includes("mcp-resources") && (t.includes("已启用 · ") || t.includes("已停用 · "))),
  "the resource plugin must not be listed as a server",
);

// --- Case 3b: no resource plugin -----------------------------------------
const noResProps = { sessionId: "s1b", load: async () => payloadNoResources };
mount(noResProps);
await settle();
text = textOf(render(noResProps));
log("case3b (no resources)", render(noResProps));
check(!has(text, "资源工具"), "no resource line when the plugin is absent");
check(text.includes("MCP"), "the MCP mark survives without the resource plugin");

// --- Case 4: tool registry read failed -----------------------------------
const badProps = { sessionId: "s2", load: async () => ({ ...payloadOk, tools: { error: "boom" } }) };
mount(badProps);
await settle();
// Full commit sequence: this case carries enabled rows and an unreadable registry,
// which is exactly the shape that must NOT be called a fault. Without the commit
// stage a wrongly-opened dialog would stay invisible and the check would lie.
render(badProps);
await settle();
render(badProps);
text = textOf(render(badProps));
log("case4 (tools failed)", render(badProps));
check(text.includes("读取失败"), "a failed tool-registry read must say 读取失败");
check(!text.includes("未连接"), "a failed registry read must not be reported as disconnected");
check(findDialog(render(badProps)) === undefined, "a failed registry read must NOT be called a fault");
check(!has(text, "资源工具"), "a failed registry read must not invent a resource line");

// --- Case 4b: configured server whose tools never registered -------------
// The fault case, and the reason this plugin exists: the Loader carries the row
// and marks it enabled, but no `mcp__local__*` tool is registered. The reader
// must be told, not left to discover it.
mount(disconnectedProps);
await settle();
// The fault effect is keyed on the payload-derived fault key, so it first runs on
// the render AFTER the read landed. It then calls setAlertOpen(true), whose value
// only appears on the following render — which is exactly React's commit order.
render(disconnectedProps);
await settle();
// One more render shows the committed `alertOpen: true`.
render(disconnectedProps);
text = textOf(render(disconnectedProps));
log("case4b (configured but disconnected)", render(disconnectedProps));
check(text.includes("连接故障"), "a configured server with no registered tools must read 连接故障");
check(!text.includes("未连接"), "a real fault must not be softened to 未连接");
check(text.includes("连接故障"), "a configured-but-disconnected server must read 连接故障");
// The dialog must open by itself — this is the whole point of the feature.
const dialogNode = findDialog(render(disconnectedProps));
check(dialogNode !== undefined, "the fault dialog must open on its own when a configured server registers no tools");
check(dialogNode?.props.title === "MCP 连接故障", "the dialog must be titled as a fault");
const dialogText = dialogNode === undefined ? [] : [...textOf(dialogNode.children), ...textOf(dialogNode.props.footer)];
check(has(dialogText, "没有任何一个注册了工具"), "the dialog must state the fault plainly");
check(has(dialogText, "mcp-local"), "the dialog must name the affected servers");
check(has(dialogText, "知道了"), "the dialog must be dismissible");
const expand4b = findButton(render(disconnectedProps), "明细");
if (expand4b) expand4b.props.onClick();
text = textOf(render(disconnectedProps));
check(has(text, "没有 MCP 服务器注册工具"), "the panel must state that no server registered tools");
check(has(text, "已配置 1 个客户端条目"), "the configured row must still be listed apart");

// --- Case 5: empty but successful ----------------------------------------
// No MCP configured at all. This is NOT a fault: nagging about a feature the
// reader does not use is noise, and noise gets a plugin uninstalled.
const emptyProps = { sessionId: "s3", load: async () => ({ ...payloadOk, tools: { servers: [], totalTools: 0 }, inventory: { snapshot: { entries: [] } }, mcpRows: [], mcpResources: null }) };
mount(emptyProps);
await settle();
// Full commit sequence: a negative check that never reaches the commit stage
// would pass even if the dialog wrongly opened.
render(emptyProps);
await settle();
render(emptyProps);
text = textOf(render(emptyProps));
check(text.includes("未连接"), "an empty successful read must say 未连接");
check(findDialog(render(emptyProps)) === undefined, "no MCP configured must NOT open the fault dialog");
check(!text.includes("连接故障"), "no MCP configured must NOT read 连接故障");

// --- Case 5a: every MCP row disabled -------------------------------------
// Configured but deliberately switched off is also not a fault.
const disabledProps = {
  sessionId: "s3a",
  load: async () => ({
    ...payloadOk,
    tools: { servers: [], totalTools: 0 },
    inventory: { snapshot: { entries: [{ ...mcpEntry, enabled: false }] } },
    mcpRows: [{ ...mcpEntry, enabled: false }],
    mcpResources: null,
  }),
};
mount(disabledProps);
await settle();
render(disabledProps);
await settle();
render(disabledProps);
text = textOf(render(disabledProps));
check(findDialog(render(disabledProps)) === undefined, "a disabled MCP row must NOT open the fault dialog");
check(text.includes("未连接"), "a disabled MCP row reads 未连接, not a fault");

// --- Case 5a2: registry read failed, rows enabled ------------------------
// The strip cannot tell whether this is a fault, so it must not accuse.
const unreadableProps = {
  sessionId: "s3b",
  load: async () => ({ ...payloadOk, tools: { error: "boom" } }),
};
mount(unreadableProps);
await settle();
// The full commit sequence, or a dialog that SHOULD have opened would not appear
// and this negative check would pass for the wrong reason.
render(unreadableProps);
await settle();
render(unreadableProps);
text = textOf(render(unreadableProps));
check(findDialog(render(unreadableProps)) === undefined, "an unreadable registry must NOT open the fault dialog");
check(text.includes("读取失败"), "an unreadable registry still reports 读取失败");

// --- Case 5b: skills read failed -----------------------------------------
// Each block fails independently, so a skills failure must not blank MCP.
const skillsBadProps = {
  sessionId: "s5",
  load: async () => ({ ...payloadOk, skills: { error: "denied" } }),
};
mount(skillsBadProps);
await settle();
text = textOf(render(skillsBadProps));
log("case5b (skills failed)", render(skillsBadProps));
check(has(text, "读取失败"), "a failed skills read must say 读取失败");
check(text.includes("MCP"), "a skills failure must not blank the MCP mark");
const expand5b = findButton(render(skillsBadProps), "明细");
if (expand5b) expand5b.props.onClick();
text = textOf(render(skillsBadProps));
check(has(text, "skills/list 读取失败"), "the expanded skills block must name its failing Remote");

// --- Case 5c: bundles read failed ----------------------------------------
const bundlesBadProps = {
  sessionId: "s6",
  load: async () => ({ ...payloadOk, bundles: { error: "no manager" } }),
};
mount(bundlesBadProps);
await settle();
render(bundlesBadProps);
const expand5c = findButton(render(bundlesBadProps), "明细");
if (expand5c) expand5c.props.onClick();
text = textOf(render(bundlesBadProps));
log("case5c (bundles failed)", render(bundlesBadProps));
check(has(text, "pluginManager/listBundles 读取失败"), "a failed bundle read must name its failing Remote");
check(has(text, "MCP"), "a bundle failure must not blank MCP");

// --- Case 6: load throws --------------------------------------------------
const throwProps = { sessionId: "s4", load: async () => { throw new Error("network down"); } };
mount(throwProps);
await settle();
text = textOf(render(throwProps));
log("case6 (throw)", render(throwProps));
check(text.some((t) => t.includes("读取失败：network down")), "a thrown load must be shown");
check(text.includes("…"), "a thrown load leaves the counts unknown, not zero");

// --- Case 7: the strip polls itself ---------------------------------------
// 已连接 must not go stale: the strip re-reads on its own. This asserts the poll
// is registered with a sane interval, not that a timer fires (the checks drive
// the component directly).
mount(okProps);
await settle();
check(timers.length > 0, "the strip must register a self-refresh interval");
const poll = timers[timers.length - 1];
check(poll.ms > 0 && poll.ms <= 60_000, `the poll interval must be sane, saw ${poll.ms}ms`);
// A hidden tab must not read: the tick checks visibility before spending a call.
let loadCount = 0;
const countingProps = {
  sessionId: "s7",
  load: async () => {
    loadCount += 1;
    return payloadOk;
  },
};
const timerCountBefore = timers.length;
mount(countingProps);
await settle();
// The mount registered its own interval; that is the closure to drive, since an
// earlier case's tick still points at an earlier component instance.
const livePoll = timers[timers.length - 1];
check(timers.length > timerCountBefore, "each mount must register its own interval");
const before = loadCount;
globalThis.document.visibilityState = "hidden";
// The tick fires `void run(...)`, so awaiting the tick alone would not cover the
// read. The stub's `load` is counted synchronously on entry, so a short flush is
// enough to observe whether a read was started at all.
livePoll.fn();
await new Promise((r) => setImmediate(r));
check(loadCount === before, "a hidden tab must not spend a poll read");
globalThis.document.visibilityState = "visible";
livePoll.fn();
await new Promise((r) => setImmediate(r));
check(loadCount > before, "a visible tab must re-read on the poll tick");

// --- Case 8: an unchanged poll must not re-render ------------------------
// The same answer arriving again must not reach setState with a NEW object: that
// would rebuild the row and repaint every interval for nothing. The stub's
// setState does not re-render, so what is counted is the state object identity —
// a fresh object is exactly the re-render React would schedule.
const stablePayload = { ...payloadOk };
const stableProps = { sessionId: "s8", load: async () => stablePayload };
const timerCountBefore8 = timers.length;
mount(stableProps);
await settle();
check(timers.length > timerCountBefore8, "case 8 must register its own interval");
// The tick must come from THIS mount: an earlier case's tick closes over an
// earlier component instance whose state slot is no longer the one under test.
const livePoll8 = timers[timers.length - 1];
const stateSlot8 = hookState[1];
check(stateSlot8?.phase === "ready", "case 8 must have read once before polling");
const payloadBefore = stateSlot8.payload;
livePoll8.fn();
await new Promise((r) => setImmediate(r));
const stateAfterIdenticalPoll = hookState[1];
check(
  stateAfterIdenticalPoll === stateSlot8,
  "an unchanged poll must keep the same state object (no re-render)",
);
check(
  stateAfterIdenticalPoll.payload === payloadBefore,
  "an unchanged poll must keep the same payload reference",
);

// A changed answer MUST produce a new state: suppression must not swallow news.
let flipped = false;
const changingProps = {
  sessionId: "s9",
  load: async () => (flipped ? { ...payloadOk, tools: { servers: [], totalTools: 0 } } : { ...payloadOk }),
};
const timerCountBefore9 = timers.length;
mount(changingProps);
await settle();
check(timers.length > timerCountBefore9, "case 9 must register its own interval");
const livePoll9 = timers[timers.length - 1];
const stateSlot9 = hookState[1];
flipped = true;
livePoll9.fn();
await new Promise((r) => setImmediate(r));
check(hookState[1] !== stateSlot9, "a changed poll must produce new state (re-render)");
check(
  (hookState[1].payload?.tools?.servers ?? []).length === 0,
  "a changed poll must show the new answer",
);

// --- Case 10: a slow read must not stack requests -------------------------
// Without an in-flight guard, a read that outlives the interval would be asked
// again on every tick, piling up work against a Host that is already struggling.
let slowCalls = 0;
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const slowProps = {
  sessionId: "s10",
  load: async () => {
    slowCalls += 1;
    await gate;
    return payloadOk;
  },
};
const timerCountBefore10 = timers.length;
mount(slowProps);
// Flush the effects so the interval is registered and the mount read is STARTED.
// The read itself stays pending on the gate, which is the state under test.
for (const fn of [...effects]) await fn();
check(timers.length > timerCountBefore10, "case 10 must register its own interval");
const livePoll10 = timers[timers.length - 1];
await new Promise((r) => setImmediate(r));
const callsBeforeTicks = slowCalls;
check(callsBeforeTicks >= 1, "the mount read must have started");
// Fire three ticks while the first read is still pending.
livePoll10.fn();
livePoll10.fn();
livePoll10.fn();
await new Promise((r) => setImmediate(r));
check(
  slowCalls === callsBeforeTicks,
  `ticks during an in-flight read must not start another (saw ${slowCalls}, before ${callsBeforeTicks})`,
);
// Releasing the gate lets the pending read finish; the next tick may then run.
release();
await new Promise((r) => setImmediate(r));
livePoll10.fn();
await new Promise((r) => setImmediate(r));
check(slowCalls > callsBeforeTicks, "after the in-flight read settles, a tick must read again");

console.log("---");
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log("  - " + p);
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
