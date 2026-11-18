// Minimal EVM bytecode helpers: selector extraction and proxy detection.
import { client } from "./chain.js";

const PUSH1 = 0x60;
const PUSH32 = 0x7f;
const PUSH4 = 0x63;

/** Walk opcodes (skipping push data) and collect every PUSH4 operand. */
export function extractSelectors(code) {
  const bytes = Buffer.from(code.replace(/^0x/, ""), "hex");
  const selectors = new Set();
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op >= PUSH1 && op <= PUSH32) {
      const n = op - PUSH1 + 1;
      if (op === PUSH4 && i + 4 < bytes.length) {
        selectors.add("0x" + bytes.subarray(i + 1, i + 5).toString("hex"));
      }
      i += n;
    }
  }
  return selectors;
}

const EIP1967_IMPL =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const EIP1967_ADMIN =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const slotToAddress = (v) =>
  v && BigInt(v) !== 0n ? "0x" + v.slice(-40).toLowerCase() : null;

/** Detect EIP-1167 minimal proxies and EIP-1967 proxies; returns implementation info. */
export async function detectProxy(address, code) {
  const hex = code.toLowerCase();
  const m = hex.match(
    /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/,
  );
  if (m)
    return {
      kind: "EIP-1167 minimal proxy (clone)",
      implementation: "0x" + m[1],
      admin: null,
    };

  const [impl, beacon, admin] = await Promise.all(
    [EIP1967_IMPL, EIP1967_BEACON, EIP1967_ADMIN].map((slot) =>
      client.getStorageAt({ address, slot }).catch(() => null),
    ),
  );
  if (slotToAddress(impl)) {
    return {
      kind: "EIP-1967 upgradeable proxy",
      implementation: slotToAddress(impl),
      admin: slotToAddress(admin),
    };
  }
  if (slotToAddress(beacon)) {
    const b = slotToAddress(beacon);
    let implementation = null;
    try {
      const r = await client.call({ to: b, data: "0x5c60da1b" }); // implementation()
      implementation = r.data ? "0x" + r.data.slice(-40) : null;
    } catch {}
    return {
      kind: "EIP-1967 beacon proxy",
      implementation,
      admin: slotToAddress(admin),
      beacon: b,
    };
  }
  return null;
}
