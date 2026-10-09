#!/usr/bin/env node
import { connectStdioProxy } from "../lib/stdio-proxy.mjs";

try {
  const args = process.argv.slice(2);
  const number = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const value = Number(args[index + 1]);
    if (!Number.isInteger(value) || value < 1000) throw new Error(`${flag} 必须为不小于 1000 的整数。`);
    return value;
  };
  const bridge = await connectStdioProxy({
    idleTimeoutMs: number("--idle-timeout-ms"), leaseTtlMs: number("--lease-ttl-ms")
  });
  const close = () => { void bridge.close().then(() => process.exit(0)); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
} catch (error) {
  process.stderr.write(`${error.message || "原生工作台未能启动。"}\n`);
  process.exitCode = 1;
}
