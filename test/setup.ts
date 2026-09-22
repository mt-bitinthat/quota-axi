import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const name of [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]) {
  delete process.env[name];
}

// No test may read this machine's real GitHub CLI login: point `gh`'s own
// configuration directory at a path that never exists. Tests that exercise the
// store set their own sandbox directory.
process.env.GH_CONFIG_DIR = join(
  tmpdir(),
  `quota-axi-test-no-gh-config-${process.pid}-${randomUUID()}`,
);

// Native Copilot metadata must never come from the developer's real profile.
process.env.COPILOT_HOME = join(
  tmpdir(),
  `quota-axi-test-no-copilot-config-${process.pid}-${randomUUID()}`,
);

// The box-dashboard fork reads an operator-supplied `box.json` and shells out to
// ccusage. No suite may see this machine's real configuration, and no suite may
// spawn a vendor CLI by accident, so both are pointed away by default. Tests
// that exercise either supply their own path or injected runner.
process.env.XDG_CONFIG_HOME = join(
  tmpdir(),
  `quota-axi-test-no-box-config-${process.pid}-${randomUUID()}`,
);
process.env.QUOTA_AXI_CCUSAGE = "off";
