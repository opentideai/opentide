// Run by runner_integration_test.ts under the runner's flags. Tries what user
// code must not do and prints, for each, the error name or "allowed".
const [configPath, projectDir, denoDir, scratchDir, port, ifaceAddress] =
  Deno.args;

async function attempt(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "allowed";
  } catch (err) {
    return err instanceof Error ? err.name : String(err);
  }
}

const fetchOn = (host: string) => () =>
  fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2_000) })
    .then((r) => r.body?.cancel());

const results: Record<string, string> = {
  readKeys: await attempt(() => Deno.readTextFile(configPath!)),
  readKernelToken: await attempt(() =>
    Deno.readTextFile(`${projectDir}/.opentide/kernel.token`)
  ),
  readDotEnv: await attempt(() => Deno.readTextFile(`${projectDir}/.env`)),
  spawnShell: await attempt(() =>
    new Deno.Command("/bin/sh", { args: ["-c", "id"] }).outputSync()
  ),
  fetch127: await attempt(fetchOn("127.0.0.1")),
  fetchLocalhost: await attempt(fetchOn("localhost")),
  fetchZero: await attempt(fetchOn("0.0.0.0")),
  fetchV6Loopback: await attempt(fetchOn("[::1]")),
  fetchInterface: await attempt(fetchOn(ifaceAddress!)),
  writeDenoDir: await attempt(() =>
    Deno.writeTextFile(`${denoDir}/poisoned.js`, "x")
  ),
  symlink: await attempt(() => Deno.symlink(configPath!, `${scratchDir}/link`)),
  ffi: await attempt(() => Deno.dlopen("libc.so.6", {})),
  sys: await attempt(() => Deno.hostname()),
  writeScratch: await attempt(() =>
    Deno.writeTextFile(`${scratchDir}/ok.txt`, "ok")
  ),
};

console.log(JSON.stringify({
  results,
  env: Deno.env.toObject(),
}));
