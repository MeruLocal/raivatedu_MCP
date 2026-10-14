#!/usr/bin/env node
// Fails when package.json and server.json disagree on the version.
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const pkg = read("package.json").version;
const server = read("server.json");
const mismatches = [];
if (server.version !== pkg) mismatches.push(`server.json version ${server.version}`);
for (const p of server.packages ?? []) {
  if (p.version !== pkg) mismatches.push(`server.json package ${p.identifier} ${p.version}`);
}
if (mismatches.length) {
  console.error(`Version mismatch with package.json ${pkg}: ${mismatches.join(", ")}`);
  process.exit(1);
}
console.log(`Versions match: ${pkg}`);
