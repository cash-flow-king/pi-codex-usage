import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { queryUsage, resolveCodexExecutable } from "../lib/query.ts";

function fixture(run: (dir: string, file: (path: string, content?: string) => string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "codex launcher & spaces-"));
  const file = (path: string, content = "") => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  try { run(dir, file); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("non-Windows platforms retain normal Codex PATH lookup", () => {
  for (const platform of ["linux", "darwin"] as const)
    assert.equal(resolveCodexExecutable(platform, {}), "codex");
});

test("Windows resolves standalone executables and respects PATH order and quoted spaces", () => fixture((dir, file) => {
  const first = file("first/codex.exe");
  file("second/codex.exe");
  assert.equal(resolveCodexExecutable("win32", { Path: `;"${dirname(first)}";${join(dir, "second")}` }), first);
}));

for (const arch of ["x64", "arm64"]) test(`Windows resolves npm optional-package binaries for ${arch}`, () => fixture((dir, file) => {
  file("codex.cmd");
  const root = "node_modules/@openai/codex";
  file(`${root}/package.json`, '{"name":"@openai/codex"}');
  const optional = `${root}/node_modules/@openai/codex-win32-${arch}`;
  file(`${optional}/package.json`, `{"name":"@openai/codex-win32-${arch}"}`);
  const target = arch === "x64" ? "x86_64" : "aarch64";
  const binary = file(`${optional}/vendor/${target}-pc-windows-msvc/bin/codex.exe`);
  assert.equal(resolveCodexExecutable("win32", { PATH: dir }, arch), binary);
}));

for (const layout of ["bin", "codex"]) test(`Windows resolves older bundled vendor layout ${layout}`, () => fixture((dir, file) => {
  file("codex.cmd");
  const binary = file(`node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/${layout}/codex.exe`);
  assert.equal(resolveCodexExecutable("win32", { PATH: dir }, "x64"), binary);
}));

test("missing or incomplete Windows installs fail with recovery instructions, not shell execution", () => fixture((dir, file) => {
  file("codex.cmd", "echo never run this shim");
  assert.throws(() => resolveCodexExecutable("win32", { PATH: dir }), /Install Codex.*restart Pi/);
  assert.throws(() => resolveCodexExecutable("win32", {}), /Could not find a native Codex executable/);
}));

for (const mode of ["success", "startup-error", "rpc-error", "exit", "timeout", "lost-claim"] as const)
  test(`CLI fallback after HTTP 401: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex rpc fixture-"));
    const script = join(dir, "rpc.cjs");
    const originalSpawn = childProcess.spawn;
    const previousFetch = globalThis.fetch;
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "PATH";
    const previousPath = process.env[pathKey];
    writeFileSync(join(dir, "codex.exe"), "fixture only; never executed");
    writeFileSync(script, `
      const readline = require('node:readline');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (${JSON.stringify(mode)} === 'timeout') return;
        if (${JSON.stringify(mode)} === 'exit') return process.exit(2);
        const result = request.method === 'initialize' ? {} : {
          rateLimits: { limitId:'codex', primary:{usedPercent:42} }
        };
        const response = request.method === 'account/rateLimits/read' && ${JSON.stringify(mode)} === 'rpc-error'
          ? {id:request.id,error:{message:'fixture quota denied'}} : {id:request.id,result};
        process.stdout.write(JSON.stringify(response)+'\\n');
      });
    `);
    let launches = 0;
    let admissionChecks = 0;
    let child: ReturnType<typeof originalSpawn> | undefined;
    let childClosed: Promise<void> | undefined;
    childProcess.spawn = ((command: string, args: string[], options: any) => {
      launches++;
      assert.equal(command, process.platform === "win32" ? join(dir, "codex.exe") : "codex");
      assert.deepEqual(args, ["app-server", "--listen", "stdio://"]);
      assert.equal(options.shell, undefined);
      assert.equal(options.windowsHide, true);
      child = mode === "startup-error"
        ? originalSpawn(join(dir, "missing-executable"), [], options)
        : originalSpawn(process.execPath, [script], options);
      childClosed = new Promise(resolve => child!.once("close", () => resolve()));
      return child;
    }) as typeof childProcess.spawn;
    syncBuiltinESMExports();
    process.env[pathKey] = dir;
    globalThis.fetch = async () => new Response('{"error":"Unauthorized"}', { status: 401 });
    const model = { id: "fixture", name: "Fixture", provider: "openai-codex" };
    const ctx = { model, modelRegistry: {
      getAvailable: () => [model], getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture" }),
    } } as never;
    try {
      const result = await queryUsage(ctx, { timeoutMs: 1000 }, model, () => {
        admissionChecks++;
        return mode !== "lost-claim" || admissionChecks < 5;
      });
      assert.equal(launches, 1);
      if (mode === "success") {
        assert.equal(result?.ok, true);
        if (result?.ok) assert.equal(result.report.snapshots[0].primary?.usedPercent, 42);
      } else if (mode === "lost-claim") {
        assert.equal(result, undefined);
      } else {
        assert.equal(result?.ok, false);
        if (result && !result.ok) {
          assert.match(result.errors[0].message, /returned 401/);
          const pattern = mode === "startup-error" ? /Failed to start codex app-server:.*ENOENT/
            : mode === "rpc-error" ? /fixture quota denied/
            : mode === "exit" ? /exited.*code 2/ : /Timed out.*initialize/;
          assert.match(result.errors[1].message, pattern);
        }
      }
      assert.ok(child, "the fallback must create a process");
      assert.ok(childClosed, "the process must have a close observer");
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          childClosed,
          new Promise<never>((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error("CLI process did not close after disposal")), 3000);
          }),
        ]);
      } finally { clearTimeout(closeTimer); }
      assert.ok(child.exitCode !== null || child.signalCode !== null, "the CLI actually exited, not merely received a kill request");
    } finally {
      child?.kill();
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
      globalThis.fetch = previousFetch;
      if (previousPath === undefined) delete process.env[pathKey];
      else process.env[pathKey] = previousPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
