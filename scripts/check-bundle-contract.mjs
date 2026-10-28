// Load the browser bundle against a stub module loader and assert the contract
// DSH's client module system relies on:
//   - the script registers exactly one factory whose id equals the package name
//   - the factory requires only baseline modules
//   - the exported inject list and apply() shape are what Cordis expects
//   - apply() registers into the dock slot with the documented options
// No browser, no DSH runtime: only the contract is exercised.
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
/** Package root: this script lives in <root>/scripts. */
const pkgDir = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(pkgDir, "lib/client.js"), "utf8");

const problems = [];
const registrations = [];

// Minimal `window.__ModuleLoader__`.
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};

const BASELINE = new Set([
  "react",
  "react-dom",
  "react/jsx-runtime",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-dockkit",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-slots",
]);

const required = [];

/** A pass-through JSX-ish stub: enough to build a tree, not to render it. */
const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children,
});

const hooks = { state: [], index: 0 };
const React = {
  createElement,
  useState(initial) {
    const i = hooks.index++;
    if (hooks.state[i] === undefined) hooks.state[i] = initial;
    const set = (next) => {
      hooks.state[i] = typeof next === "function" ? next(hooks.state[i]) : next;
    };
    return [hooks.state[i], set];
  },
  useRef(initial) {
    const i = hooks.index++;
    if (hooks.state[i] === undefined) hooks.state[i] = { current: initial };
    return hooks.state[i];
  },
  useCallback(fn) {
    hooks.index++;
    return fn;
  },
  useEffect() {
    hooks.index++;
  },
};

const moduleStub = (id) => {
  if (id === "react") return React;
  if (id === "@deepseek-ai/dsh-client-ui-primitives") {
    // Every primitive the bundle touches must exist; a Proxy lets us record
    // names rather than guess them.
    return new Proxy(
      {},
      {
        get(_t, key) {
          if (typeof key !== "string") return undefined;
          return function Primitive(props) {
            return { type: key, props, children: [] };
          };
        },
        has: () => true,
      },
    );
  }
  return {};
};

// Evaluate the bundle.
new Function("window", source)(globalThis.window);

if (registrations.length !== 1) {
  problems.push(`expected exactly 1 registration, saw ${registrations.length}`);
}
const registration = registrations[0];
if (registration === undefined) {
  console.log("FATAL: bundle registered nothing");
  process.exit(1);
}
if (registration.id !== pkg.name) {
  problems.push(`registration id ${JSON.stringify(registration.id)} != package name ${JSON.stringify(pkg.name)}`);
}
console.log(`factory id: ${registration.id}`);
console.log(`package name: ${pkg.name}`);

const exportsObj = registration.factory((specifier) => {
  required.push(specifier);
  if (!BASELINE.has(specifier)) {
    problems.push(`requires non-baseline module ${JSON.stringify(specifier)} (needs dsh.client.external)`);
  }
  return moduleStub(specifier);
});

console.log("required modules:", JSON.stringify(required));
console.log("exported keys:", JSON.stringify(Object.keys(exportsObj).sort()));

if (typeof exportsObj.apply !== "function") problems.push("missing apply()");
if (!Array.isArray(exportsObj.inject)) problems.push("inject must be an array");

const injectList = exportsObj.inject ?? [];
console.log("inject list:", JSON.stringify(injectList));
if (!injectList.includes("slots")) problems.push("inject must include 'slots'");
// `connection` carries the call to this package's own host half (tool registry).
if (!injectList.includes("connection")) problems.push("inject must include 'connection' (host tool route)");
for (const ns of ["remote.skills", "remote.pluginInventory", "remote.pluginManager"]) {
  if (!injectList.includes(ns)) problems.push(`inject must include ${ns} (read at runtime)`);
}
if (injectList.includes("sessions")) problems.push("inject lists 'sessions' but the bundle never reads it");

// Drive apply() against a recording ctx.
const slotCalls = [];
const registered = [];
const ctx = {
  remote: {
    skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
    pluginInventory: { list: async () => ({ ok: true, value: { entries: [] } }) },
    pluginManager: { listBundles: async () => ({ ok: true, value: [] }) },
  },
  // The client-connection plugin provides this at runtime; the strip only needs
  // it to reach its own host half, so a recording stub is enough for the contract.
  connection: {
    rpc: {
      call: async () => ({ ok: true, value: { ok: true, servers: [], totalTools: 0 } }),
    },
  },
  slots: {
    inject(name, register) {
      slotCalls.push(name);
      register();
      return () => {};
    },
    register(options, component) {
      registered.push({ options, component });
      return () => {};
    },
  },
};

const dispose = exportsObj.apply(ctx);
console.log("slots.inject called with:", JSON.stringify(slotCalls));
console.log("slots.register called:", registered.length);

if (slotCalls.length !== 1) problems.push(`expected 1 slots.inject call, saw ${slotCalls.length}`);
if (slotCalls[0] !== "conversation.composer.dock") {
  problems.push(`unexpected slot ${JSON.stringify(slotCalls[0])}`);
}
if (registered.length !== 1) problems.push(`expected 1 registration, saw ${registered.length}`);

const reg = registered[0];
if (reg !== undefined) {
  const o = reg.options;
  console.log("registration options:", JSON.stringify({ name: o.name, id: o.id, order: o.order }));
  if (o.name !== "conversation.composer.dock") problems.push("registration name must match the slot");
  if (typeof o.inject !== "function") problems.push("dock registration needs an inject face for the session id");
  if (typeof reg.component !== "function") problems.push("dock registration needs a component function");
  if (typeof o.inject === "function") {
    const face = o.inject("session-under-test");
    console.log("inject face keys:", JSON.stringify(Object.keys(face)));
    if (typeof face.load !== "function") problems.push("inject face must expose load()");
    // `sessionId` must NOT be returned: it is a built-in standard prop already.
    if (Object.hasOwn(face, "sessionId")) {
      problems.push("inject face must not return sessionId (it would shadow the standard prop)");
    }
  }
}

if (typeof dispose === "function") dispose();

console.log("---");
if (problems.length > 0) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log("  - " + p);
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
