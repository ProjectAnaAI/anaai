const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(
  ...parts
) {
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

const compactLayout =
  layout.replace(/\s+/g, " ");

const compactSidebar =
  sidebar.replace(/\s+/g, " ");

const compactTopbar =
  topbar.replace(/\s+/g, " ");

test("app shell provides responsive content padding and mobile navigation state", () => {
  assert.match(
    compactLayout,
    /mobileNavigationOpen/
  );

  assert.match(
    compactLayout,
    /px-4 py-6 sm:px-6 lg:p-8/
  );

  assert.match(
    compactLayout,
    /min-w-0 flex-1/
  );
});

test("sidebar keeps desktop navigation and adds a mobile navigation dialog", () => {
  assert.match(
    compactSidebar,
    /hidden min-h-screen w-72/
  );

  assert.match(
    compactSidebar,
    /role="dialog"/
  );

  assert.match(
    compactSidebar,
    /aria-modal="true"/
  );

  assert.match(
    compactSidebar,
    /lg:hidden/
  );
});

test("navigation exposes active page semantics", () => {
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

test("mobile navigation closes when a destination is selected", () => {
  assert.match(
    compactSidebar,
    /function navigate\( href: string \)/
  );

  assert.match(
    compactSidebar,
    /onMobileClose\(\); router\.push\(href\)/
  );
});

test("topbar exposes the mobile navigation trigger", () => {
  assert.match(
    compactTopbar,
    /aria-label="Open navigation"/
  );

  assert.match(
    compactTopbar,
    /onClick=\{ onOpenNavigation \}/
  );

  assert.match(
    compactTopbar,
    /lg:hidden/
  );
});

test("topbar preserves business selection and logout controls", () => {
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

test("sidebar retains all primary product destinations", () => {
  const destinations = [
    "/dashboard",
    "/appointments",
    "/customers",
    "/business",
    "/services",
    "/analytics",
    "/knowledge",
    "/ai",
    "/settings",
  ];

  for (
    const destination of destinations
  ) {
    assert.match(
      sidebar,
      new RegExp(
        `href: "${destination.replace(
          "/",
          "\\/"
        )}"`
      )
    );
  }
});