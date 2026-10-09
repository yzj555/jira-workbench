import { startNativeRuntime } from "../lib/runtime-server.mjs";
import { defaultNativeDataRoot } from "../lib/runtime-client.mjs";

const args = process.argv.slice(2);
function value(flag, fallback) {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
}
try {
  const runtime = await startNativeRuntime({
    dataRoot: value("--data-root", defaultNativeDataRoot()),
    idleTimeoutMs: Math.max(1000, Number(value("--idle-timeout-ms", 15000))),
    leaseTtlMs: Math.max(3000, Number(value("--lease-ttl-ms", 45000))),
    onIdle: () => process.exit(0)
  });
  const close = () => { void runtime.close().then(() => process.exit(0)); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  // An occupied deterministic listener means another writer already owns it.
  process.stderr.write(error.code === "EADDRINUSE"
    ? "原生服务已运行或端口被占用；未启动第二个实例。\n"
    : "原生服务启动失败，请检查插件文件及本地目录权限。\n");
  process.exitCode = 1;
}
