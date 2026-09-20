const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(...parts) {
  return fs.readFileSync(
    path.join(
      process.cwd(),
      ...parts
    ),
    "utf8"
  );
}

const settings = read(
  "app",
  "settings",
  "page.tsx"
);

const compactSettings =
  settings
    .replace(/\s+/g, " ")
    .trim();

test("settings uses the shared toast system instead of browser alerts", () => {
  assert.match(
    compactSettings,
    /import \{ toast \} from "sonner"/
  );

  assert.match(
    compactSettings,
    /toast\.error\(/
  );

  assert.doesNotMatch(
    compactSettings,
    /\balert\(/
  );
});

test("settings logout has an in-progress state", () => {
  assert.match(
    compactSettings,
    /useState\(false\)/
  );

  assert.match(
    compactSettings,
    /if \(loggingOut\) \{ return; \}/
  );

  assert.match(
    compactSettings,
    /setLoggingOut\(true\)/
  );

  assert.match(
    compactSettings,
    /disabled=\{loggingOut\}/
  );

  assert.match(
    compactSettings,
    /"Logging out\.\.\."/
  );
});

test("failed logout restores the interactive state", () => {
  assert.match(
    compactSettings,
    /if \(error\) \{/
  );

  assert.match(
    compactSettings,
    /toast\.error\( "Unable to log out\. Please try again\." \)/
  );

  assert.match(
    compactSettings,
    /if \(error\) \{[\s\S]*?setLoggingOut\(false\);[\s\S]*?return; \}/
  );
});

test("successful logout returns to login and refreshes routing state", () => {
  assert.match(
    compactSettings,
    /router\.push\("\/login"\); router\.refresh\(\);/
  );
});