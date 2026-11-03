// Integration tests: run the real server over stdio, no network to Modrinth.
// Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** Spawn the server and return helpers for line-delimited JSON-RPC. */
function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MODRINTH_TOKEN: "test-token", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const ready = new Promise((resolve) =>
    child.stderr.on("data", (d) => String(d).includes("ready") && resolve()),
  );
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const init = async () => {
    await ready;
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  return { child, request, init, exited };
}

const within = (ms, p) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))]);

test("a stalled Modrinth request fails fast instead of hanging", async () => {
  // Accepts the connection but never responds.
  const stall = createServer(() => {});
  await new Promise((r) => stall.listen(0, "127.0.0.1", r));
  const { port } = stall.address();
  const srv = startServer({ MODRINTH_API_URL: `http://127.0.0.1:${port}`, MODRINTH_TIMEOUT_MS: "500" });
  try {
    await srv.init();
    const res = await within(5000, srv.request("tools/call", { name: "modrinth_whoami", arguments: {} }));
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /timed out after 500ms/);
  } finally {
    srv.child.kill();
    stall.closeAllConnections();
    stall.close();
  }
});

test("exits when the client closes stdin", async () => {
  const srv = startServer();
  await srv.init();
  srv.child.stdin.end();
  const { code } = await within(5000, srv.exited);
  assert.equal(code, 0);
});

// On Windows, process.kill() always hard-terminates, so a console Ctrl+C can't be
// simulated here; see the "Development" section of the README for the manual check.
test("survives SIGINT and keeps answering", { skip: process.platform === "win32" }, async () => {
  const srv = startServer();
  try {
    await srv.init();
    srv.child.kill("SIGINT");
    const res = await within(5000, srv.request("tools/list", {}));
    assert.ok(res.result.tools.length > 0);
  } finally {
    srv.child.kill("SIGKILL");
  }
});
