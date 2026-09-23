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

const layout = read(
  "components",
  "layout",
  "AppLayout.tsx"
);

const sidebar = read(
  "components",
  "layout",
  "Sidebar.tsx"
);

const topbar = read(
  "components",
  "layout",
  "Topbar.tsx"
);

const button = read(
  "components",
  "ui",
  "button.tsx"
);

const globals = read(
  "app",
  "globals.css"
);

const design = read("app", "design-system.css");
const dialog = read("components", "ui", "dialog-surface.tsx");

const compactLayout =
  layout.replace(/\s+/g, " ");

const compactSidebar =
  sidebar.replace(/\s+/g, " ");

const compactTopbar =
  topbar.replace(/\s+/g, " ");

const compactButton =
  button.replace(/\s+/g, " ");

test("app shell uses the shared AnaAI page container", () => {
  assert.match(
    compactLayout,
    /className="anaai-page"/
  );

  assert.match(
    compactLayout,
    /min-w-0 flex-1/
  );

  assert.match(
    design,
    /\.workspace-content\s*\{[^}]*padding:/
  );

  assert.match(
    compactLayout,
    /id="workspace-content"/
  );
});

test("desktop and iPad landscape retain persistent navigation", () => {
  assert.match(
    design,
    /\.workspace-sidebar\s*\{[^}]*display: none;[^}]*width: 218px;/
  );

  assert.match(
    design,
    /@media \(min-width: 1024px\)\s*\{\s*\.workspace-sidebar\s*\{\s*display: block;/
  );

  assert.match(
    design,
    /\.workspace-sidebar\s*\{[^}]*position: sticky;[^}]*top: 0;/
  );
});

test("portrait and narrow layouts expose navigation as a dialog", () => {
  assert.match(
    dialog,
    /<dialog/
  );

  assert.match(
    dialog,
    /dialog\?\.showModal\(\)/
  );

  assert.match(
    compactSidebar,
    /mobileOpen &&/
  );

  assert.match(
    compactTopbar,
    /aria-label="Open navigation"/
  );
});

test("primary navigation remains touch friendly and exposes active page semantics", () => {
  assert.match(
    design,
    /\.nav-group a,[\s\S]*?min-height: 44px;/
  );

  assert.match(
    compactSidebar,
    /aria-current=/
  );

  assert.match(
    compactSidebar,
    /"page"/
  );

  assert.match(
    compactSidebar,
    /aria-label="Primary navigation"/
  );
});

test("sidebar retains all current product destinations", () => {
  const destinations = [
    "/dashboard",
    "/appointments",
    "/customers",
    "/services",
    "/ai",
    "/knowledge",
    "/business",
    "/analytics",
    "/settings",
  ];

  for (
    const destination of destinations
  ) {
    assert.match(
      sidebar,
      new RegExp(
        `href(?:: |=)"${destination.replace(
          "/",
          "\\/"
        )}"`
      )
    );
  }
});

test("topbar preserves business selection and logout", () => {
  assert.match(
    compactTopbar,
    /<BusinessSelector \/>/
  );

  assert.match(
    compactTopbar,
    /supabase\.auth\.signOut\(\)/
  );

  assert.match(
    compactTopbar,
    /disabled=\{loggingOut\}/
  );
});

test("standard buttons use an iPad-friendly touch height", () => {
  assert.match(
    compactButton,
    /default: "h-11/
  );

  assert.match(
    compactButton,
    /icon: "size-11"/
  );

  assert.match(
    compactButton,
    /touch-manipulation/
  );
});

test("global design tokens establish AnaAI surfaces and touch targets", () => {
  assert.match(
    globals,
    /--primary: #147d52/
  );

  assert.match(
    globals,
    /\.anaai-page/
  );

  assert.match(
    globals,
    /\.anaai-surface/
  );

  assert.match(
    globals,
    /\.anaai-touch-target/
  );

  assert.match(
    globals,
    /min-height: 44px/
  );
});

test("shell does not introduce unsupported runtime or call claims", () => {
  const shell =
    `${sidebar}\n${topbar}\n${layout}`;

  assert.doesNotMatch(
    shell,
    /AnaAI Online/i
  );

  assert.doesNotMatch(
    shell,
    /calls answered/i
  );

  assert.doesNotMatch(
    shell,
    /conversion rate/i
  );
});