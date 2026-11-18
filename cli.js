#!/usr/bin/env node
import { traceFees } from "./src/trace.js";

const address = process.argv[2];
if (!address) {
  console.error("usage: npm run trace -- <token address> [robinhood|elysium]");
  process.exit(1);
}
const report = await traceFees(address, process.argv[3]);
console.log(
  JSON.stringify(
    report,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
