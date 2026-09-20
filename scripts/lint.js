// Zero-dependency lint: every JavaScript file must parse, and a few habits
// the project cares about are checked with plain string searches.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["bin", "src", "test", "scripts"];
const files = [];
for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(root);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failed += 1;
    console.error(`syntax: ${file}\n${error.stderr}`);
  }
  const text = fs.readFileSync(file, "utf8");
  if (/\bconsole\.log\(/.test(text) && file.startsWith("src/") && !file.endsWith("cli.js")) {
    failed += 1;
    console.error(`${file}: console.log in server code; use the app logger`);
  }
  if (/\t/.test(text)) {
    failed += 1;
    console.error(`${file}: tab characters`);
  }
}
console.log(`${files.length} files checked, ${failed} problem${failed === 1 ? "" : "s"}`);
process.exit(failed ? 1 : 0);
