import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import { traceFees } from "./src/trace.js";
import { CHAINS } from "./src/chain.js";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const CACHE_MS = 5 * 60_000;
const cache = new Map(); // address -> { at, promise }

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const json = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(
    JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
};

function trace(address, chain) {
  const key = `${chain || "auto"}:${address.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = traceFees(address.toLowerCase(), chain);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/trace") {
    const address = (url.searchParams.get("address") || "").trim();
    if (!isAddress(address))
      return json(res, 400, { error: "Enter a valid 0x token address." });
    // Optional: without it the chain is detected from where the contract exists.
    const chain = (url.searchParams.get("chain") || "").trim().toLowerCase();
    if (chain && !CHAINS[chain])
      return json(res, 400, {
        error: `Unknown chain. Use one of: ${Object.keys(CHAINS).join(", ")}.`,
      });
    try {
      return json(res, 200, await trace(address, chain || undefined));
    } catch (e) {
      return json(res, 502, {
        error: e.shortMessage || e.message || "Trace failed",
      });
    }
  }

  if (url.pathname === "/api/health") return json(res, 200, { ok: true });

  // Static files; unknown paths fall back to the app (so /t/0x... share links work).
  let file = normalize(
    join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname),
  );
  if (!file.startsWith(PUBLIC)) file = join(PUBLIC, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    const body = await readFile(join(PUBLIC, "index.html"));
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(body);
  }
});

server.listen(PORT, () =>
  console.log(`FeeTrace running on http://localhost:${PORT}`),
);
