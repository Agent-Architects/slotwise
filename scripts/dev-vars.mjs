// Creates .dev.vars for `wrangler dev` with a random local ENCRYPTION_KEY. Never committed (.gitignore).
import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (!existsSync(".dev.vars")) {
  writeFileSync(
    ".dev.vars",
    [`ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`, "ALLOW_SIGNUP=true", "MOCK_CALENDAR=true", ""].join("\n"),
    { mode: 0o600 },
  );
  console.log("wrote .dev.vars (local only)");
}
