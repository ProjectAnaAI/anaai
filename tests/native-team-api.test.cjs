// Run:
// NODE_PATH=<path-to-installed>/node_modules \
// node --test tests/native-team-api.test.cjs
//
// M04 Team API security/authorization regression suite.
// The authenticated member client is deliberately separate from the
// service-role client. Team security rows must only be accessed after
// authorizedMember() has established the user, business, and account role.

const { test } = require("node:test");
const strict = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");

const assert = Object.assign((...args) => strict(...args), strict, {
  deepEqual(actual, expected, message) {
    strict.deepEqual(
      JSON.parse(JSON.stringify(actual)),
      expected,
      message,
    );
  },
});

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";

const EMPLOYEE_A =
  "33333333-3333-4333-8333-333333333333";
const MANAGER_A =
  "44444444-4444-4444-8444-444444444444";
const OWNER_A =
  "55555555-5555-4555-8555-555555555555";
const INACTIVE_A =
  "66666666-6666-4666-8666-666666666666";
const EMPLOYEE_B =
  "77777777-7777-4777-8777-777777777777";

const MEMBER_USER = "member-user";

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function derivePin(pin, salt) {
  return crypto.scryptSync(pin, salt, 32).toString("base64");
}

function pinRecord(pin) {
  const salt = crypto.randomBytes(16);

  return {
    pin_hash: derivePin(pin, salt),
    pin_salt: salt.toString("base64"),
  };
}

function fixtureEmployee({
  id,
  businessId = BUSINESS_A,
  name,
  role = "employee",
  pin,
  active = true,
}) {
  return {
    id,
    business_id: businessId,
    display_name: name,
    role,
    ...pinRecord(pin),
    is_active: active,
    created_by_user_id: MEMBER_USER,
    updated_by_user_id: MEMBER_USER,
    created_at: "2026-09-29T12:00:00.000Z",
    updated_at: "2026-09-29T12:00:00.000Z",
  };
}

function harness(options = {}) {
  const memberRole = options.role || "owner";

  let authenticated = false;
  let serviceCreated = 0;
  let nextId = 0;

  const memberQueries = [];
  const serviceQueries = [];
  const serviceWrites = [];

  const memberships =
    options.memberships ||
    [
      {
        business_id: BUSINESS_A,
        user_id: MEMBER_USER,
        role: memberRole,
      },
    ];

  const employees =
    options.employees ||
    [
      fixtureEmployee({
        id: EMPLOYEE_A,
        name: "Avery Employee",
        pin: "1111",
      }),
      fixtureEmployee({
        id: MANAGER_A,
        name: "Morgan Manager",
        role: "manager",
        pin: "2222",
      }),
      fixtureEmployee({
        id: OWNER_A,
        name: "Olivia Owner",
        role: "owner",
        pin: "3333",
      }),
      fixtureEmployee({
        id: INACTIVE_A,
        name: "Inactive Person",
        pin: "4444",
        active: false,
      }),
      fixtureEmployee({
        id: EMPLOYEE_B,
        businessId: BUSINESS_B,
        name: "Other Tenant Secret",
        pin: "5555",
      }),
    ];

  const tables = {
    business_members: memberships,
    businesses: [
      {
        id: BUSINESS_A,
        name: "Business A",
        timezone: "America/Los_Angeles",
      },
      {
        id: BUSINESS_B,
        name: "Business B",
        timezone: "UTC",
      },
    ],
    employees,
  };

  function makeQuery(table, store, isService) {
    const call = {
      table,
      filters: [],
      orders: [],
      range: null,
      fields: null,
      insert: null,
      update: null,
    };

    store.push(call);

    const query = {
      select(fields) {
        call.fields = fields
          .split(/,\s*/)
          .map((field) => field.trim());
        return query;
      },

      eq(key, value) {
        call.filters.push([key, value]);
        return query;
      },

      order(key, options) {
        call.orders.push([
          key,
          options?.ascending !== false,
        ]);
        return query;
      },

      range(start, end) {
        call.range = [start, end];
        return query;
      },

      insert(values) {
        if (!isService) {
          throw new Error(
            "member client must never mutate employees",
          );
        }

        call.insert = values;
        serviceWrites.push({
          table,
          operation: "insert",
          values,
          filters: call.filters,
        });

        return query;
      },

      update(values) {
        if (!isService) {
          throw new Error(
            "member client must never mutate employees",
          );
        }

        call.update = values;
        serviceWrites.push({
          table,
          operation: "update",
          values,
          filters: call.filters,
        });

        return query;
      },

      async execute(single = false) {
        if (options.serviceDbError === table && isService) {
          return {
            data: null,
            error: {
              message: "private-service-provider-detail",
            },
          };
        }

        let rows = [...(tables[table] || [])];

        rows = rows.filter((row) =>
          call.filters.every(
            ([key, value]) => row[key] === value,
          ),
        );

        if (call.insert) {
          const row = {
            id:
              options.insertId ||
              `88888888-8888-4888-8888-${String(
                ++nextId,
              ).padStart(12, "0")}`,
            ...call.insert,
            created_at: "2026-09-29T13:00:00.000Z",
            updated_at: "2026-09-29T13:00:00.000Z",
          };

          tables[table].push(row);
          rows = [row];
        } else if (call.update) {
          rows.forEach((row) => {
            Object.assign(row, call.update);
          });
        }

        for (const [key, ascending] of [
          ...call.orders,
        ].reverse()) {
          rows.sort((left, right) => {
            const comparison = String(
              left[key] ?? "",
            ).localeCompare(String(right[key] ?? ""));

            return ascending
              ? comparison
              : -comparison;
          });
        }

        if (call.range) {
          rows = rows.slice(
            call.range[0],
            call.range[1] + 1,
          );
        }

        if (call.fields) {
          rows = rows.map((row) =>
            Object.fromEntries(
              call.fields.map((key) => [
                key,
                row[key],
              ]),
            ),
          );
        }

        return {
          data: single
            ? rows[0] ?? null
            : rows,
          error: null,
        };
      },

      maybeSingle() {
        return query.execute(true);
      },

      single() {
        return query.execute(true);
      },

      then(resolve, reject) {
        return query.execute().then(resolve, reject);
      },
    };

    return query;
  }

  const memberDb = {
    auth: {
      async getUser(token) {
        authenticated = token === "valid";

        return {
          data: {
            user: authenticated
              ? { id: MEMBER_USER }
              : null,
          },
          error: authenticated
            ? null
            : { message: "invalid token" },
        };
      },
    },

    from(table) {
      assert.ok(
        authenticated,
        "identity must be verified before member data access",
      );

      assert.notEqual(
        table,
        "employees",
        "authenticated member client must never access employees",
      );

      return makeQuery(
        table,
        memberQueries,
        false,
      );
    },
  };

  const serviceDb = {
    rpc(name, args) {
      assert.equal(name, "m04_write_employee");
      let fields;
      return {
        select(value) { fields = value; return this; },
        async single() {
          if (args.p_pin_snapshot) {
            const normalize = rows => JSON.stringify(rows.map(({id,pin_hash,pin_salt})=>({id,pin_hash,pin_salt})).sort((a,b)=>a.id.localeCompare(b.id)));
            const current = tables.employees.filter(e=>e.business_id===args.p_business_id && e.is_active);
            if (normalize(current)!==normalize(args.p_pin_snapshot)) return {data:null,error:{code:'40001'}};
          }
          const q = makeQuery("employees", serviceQueries, true);
          if (args.p_employee_id) return q.update(args.p_values).eq("business_id", args.p_business_id).eq("id", args.p_employee_id).select(fields).single();
          return q.insert(args.p_values).select(fields).single();
        },
      };
    },
    from(table) {
      assert.equal(
        table,
        "employees",
        "Team service client may only access employees in this suite",
      );

      return makeQuery(
        table,
        serviceQueries,
        true,
      );
    },
  };

  const cache = new Map();

  function load(file) {
    file = path.resolve(file);

    if (cache.has(file)) {
      return cache.get(file);
    }

    const exports = {};
    cache.set(file, exports);

    const source = fs.readFileSync(file, "utf8");

    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;

    vm.runInNewContext(
      output,
      {
        exports,
        Request,
        Response,
        URL,
        Intl,
        Date,
        Buffer,
        console: {
          error() {},
          warn() {},
          log() {},
        },
        process: {
          env: {
            NEXT_PUBLIC_SUPABASE_URL:
              "https://fixture.invalid",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture",
            SUPABASE_SECRET_KEY: "fixture-secret",
          },
        },

        require(name) {
          if (name === "@supabase/supabase-js") {
            return {
              createClient() {
                return memberDb;
              },
            };
          }

          if (name === "node:crypto") {
            return require("node:crypto");
          }

          if (name === "node:util") {
            return require("node:util");
          }

          if (
            name === "@/lib/appointment-actions"
          ) {
            return { isUuid };
          }

          if (
            name === "@/lib/supabase-server"
          ) {
            return {
              createSupabaseServiceClient() {
                serviceCreated += 1;
                return serviceDb;
              },
            };
          }

          if (name.startsWith("@/")) {
            return load(
              `${name.slice(2)}.ts`,
            );
          }

          return load(
            path.resolve(
              path.dirname(file),
              `${name}.ts`,
            ),
          );
        },
      },
      {
        filename: file,
      },
    );

    return exports;
  }

  async function call(
    kind,
    {
      url = "/team",
      method = "GET",
      body,
      token = "valid",
      business = BUSINESS_A,
    } = {},
  ) {
    const headers = {
      "x-anaai-business-id": business,
    };

    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    const request = new Request(
      `https://api.invalid/api${url}`,
      {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
      },
    );

    const handler =
      load("server/handlers/team.ts")[kind];

    const response = await handler(request);

    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  }

  return {
    tables,
    memberQueries,
    serviceQueries,
    serviceWrites,
    call,
    get serviceCreated() {
      return serviceCreated;
    },
  };
}

for (const kind of [
  "DIRECTORY",
  "CREATE",
  "UPDATE",
  "RESET_PIN",
]) {
  const request =
    kind === "DIRECTORY"
      ? {}
      : kind === "CREATE"
        ? {
            method: "POST",
            body: {
              name: "New Employee",
              role: "employee",
              pin: "9876",
            },
          }
        : kind === "UPDATE"
          ? {
              url: `/team/${EMPLOYEE_A}`,
              method: "PATCH",
              body: { name: "Updated Employee" },
            }
          : {
              url: `/team/${EMPLOYEE_A}/pin`,
              method: "POST",
              body: { pin: "9876" },
            };

  for (const token of [null, "invalid"]) {
    test(
      `${kind}: unauthenticated request rejected before service-role access (${token})`,
      async () => {
        const h = harness();

        const result = await h.call(kind, {
          ...request,
          token,
        });

        assert.equal(result.status, 401);
        assert.equal(
          h.serviceCreated,
          0,
          "service client must not exist before authentication",
        );
        assert.equal(
          h.serviceQueries.length,
          0,
        );
        assert.equal(
          h.serviceWrites.length,
          0,
        );
      },
    );
  }

  test(
    `${kind}: forged business header cannot reach service-role employee data`,
    async () => {
      const h = harness();

      const result = await h.call(kind, {
        ...request,
        business: BUSINESS_B,
      });

      assert.equal(result.status, 403);
      assert.equal(
        result.body.code,
        "BUSINESS_ACCESS_DENIED",
      );
      assert.equal(h.serviceCreated, 0);
      assert.equal(
        h.serviceQueries.length,
        0,
      );
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    },
  );
}

for (const kind of [
  "DIRECTORY",
  "CREATE",
  "UPDATE",
  "RESET_PIN",
]) {
  const request =
    kind === "DIRECTORY"
      ? {}
      : kind === "CREATE"
        ? {
            method: "POST",
            body: {
              name: "New Employee",
              role: "employee",
              pin: "9876",
            },
          }
        : kind === "UPDATE"
          ? {
              url: `/team/${EMPLOYEE_A}`,
              method: "PATCH",
              body: { name: "Changed" },
            }
          : {
              url: `/team/${EMPLOYEE_A}/pin`,
              method: "POST",
              body: { pin: "9876" },
            };

  test(
    `${kind}: staff account cannot access Team security data`,
    async () => {
      const h = harness({ role: "staff" });

      const result = await h.call(
        kind,
        request,
      );

      assert.equal(result.status, 403);
      assert.equal(
        result.body.code,
        "ROLE_FORBIDDEN",
      );
      assert.equal(
        h.serviceCreated,
        0,
        "staff rejection must happen before service client creation",
      );
      assert.equal(
        h.serviceQueries.length,
        0,
      );
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    },
  );
}

test(
  "directory: owner sees only current-business active employees and never PIN material",
  async () => {
    const h = harness({ role: "owner" });

    const result = await h.call(
      "DIRECTORY",
    );

    assert.equal(result.status, 200);
    assert.equal(
      result.headers.get("cache-control"),
      "no-store",
    );

    assert.deepEqual(
      result.body.employees.map(
        (employee) => employee.id,
      ),
      [EMPLOYEE_A, MANAGER_A, OWNER_A],
    );

    assert.ok(
      result.body.employees.every(
        (employee) =>
          employee.business_id === BUSINESS_A,
      ),
    );

    const serialized = JSON.stringify(
      result.body,
    );

    assert.ok(
      !serialized.includes("pin_hash"),
    );
    assert.ok(
      !serialized.includes("pin_salt"),
    );
    assert.ok(
      !serialized.includes(
        "Other Tenant Secret",
      ),
    );

    assert.ok(
      h.serviceQueries.every((query) =>
        query.filters.some(
          ([key, value]) =>
            key === "business_id" &&
            value === BUSINESS_A,
        ),
      ),
    );
  },
);

test(
  "directory: manager can load Team but inactive and all filters remain tenant scoped",
  async () => {
    const h = harness({ role: "manager" });

    const inactive = await h.call(
      "DIRECTORY",
      {
        url: "/team?status=inactive",
      },
    );

    assert.equal(inactive.status, 200);
    assert.deepEqual(
      inactive.body.employees.map(
        (employee) => employee.id,
      ),
      [INACTIVE_A],
    );

    const all = await h.call(
      "DIRECTORY",
      {
        url: "/team?status=all",
      },
    );

    assert.equal(all.status, 200);

    assert.deepEqual(
      all.body.employees
        .map((employee) => employee.id)
        .sort(),
      [
        EMPLOYEE_A,
        MANAGER_A,
        OWNER_A,
        INACTIVE_A,
      ].sort(),
    );

    assert.ok(
      all.body.employees.every(
        (employee) =>
          employee.business_id === BUSINESS_A,
      ),
    );
  },
);

for (const query of [
  "?status=deleted",
  `?business_id=${BUSINESS_B}`,
  "?status=all&status=active",
  "?unknown=x",
]) {
  test(
    `directory rejects invalid or client-controlled query ${query}`,
    async () => {
      const h = harness();

      const result = await h.call(
        "DIRECTORY",
        {
          url: `/team${query}`,
        },
      );

      assert.equal(result.status, 400);
      assert.equal(
        result.body.code,
        "INVALID_REQUEST",
      );
      assert.equal(
        h.serviceCreated,
        0,
      );
    },
  );
}

test(
  "create: owner creates employee with derived tenant/actor and hashed PIN",
  async () => {
    const h = harness({ role: "owner" });

    const result = await h.call(
      "CREATE",
      {
        method: "POST",
        body: {
          name: "  Jordan Lee  ",
          role: "employee",
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 201);
    assert.equal(
      result.body.employee.display_name,
      "Jordan Lee",
    );

    const write =
      h.serviceWrites.find(
        (entry) =>
          entry.operation === "insert",
      );

    assert.ok(write);

    assert.equal(
      write.values.business_id,
      BUSINESS_A,
    );
    assert.equal(
      write.values.created_by_user_id,
      MEMBER_USER,
    );
    assert.equal(
      write.values.updated_by_user_id,
      MEMBER_USER,
    );
    assert.equal(
      write.values.is_active,
      true,
    );

    assert.notEqual(
      write.values.pin_hash,
      "9876",
    );
    assert.notEqual(
      write.values.pin_salt,
      "9876",
    );

    assert.ok(
      typeof write.values.pin_hash ===
        "string" &&
        write.values.pin_hash.length > 0,
    );

    assert.ok(
      typeof write.values.pin_salt ===
        "string" &&
        write.values.pin_salt.length > 0,
    );

    const serialized = JSON.stringify(
      result.body,
    );

    assert.ok(
      !serialized.includes("pin_hash"),
    );
    assert.ok(
      !serialized.includes("pin_salt"),
    );
    assert.ok(!serialized.includes("9876"));
  },
);

test(
  "create: manager may create employees only",
  async () => {
    const employeeHarness = harness({
      role: "manager",
    });

    const employee =
      await employeeHarness.call(
        "CREATE",
        {
          method: "POST",
          body: {
            name: "Employee",
            role: "employee",
            pin: "9876",
          },
        },
      );

    assert.equal(employee.status, 201);

    for (const role of ["manager", "owner"]) {
      const h = harness({
        role: "manager",
      });

      const result = await h.call(
        "CREATE",
        {
          method: "POST",
          body: {
            name: `Forbidden ${role}`,
            role,
            pin: "9876",
          },
        },
      );

      assert.equal(result.status, 403);
      assert.equal(
        result.body.code,
        "ROLE_FORBIDDEN",
      );
      assert.equal(
        h.serviceCreated,
        0,
        "manager role assignment must be rejected before service access",
      );
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    }
  },
);

test(
  "create: owner may create manager employee",
  async () => {
    const h = harness({
      role: "owner",
    });

    const result = await h.call(
      "CREATE",
      {
        method: "POST",
        body: {
          name: "New Manager",
          role: "manager",
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 201);
    assert.equal(
      result.body.employee.role,
      "manager",
    );
  },
);

test(
  "create: duplicate active PIN is rejected",
  async () => {
    const h = harness();

    const result = await h.call(
      "CREATE",
      {
        method: "POST",
        body: {
          name: "Duplicate",
          role: "employee",
          pin: "1111",
        },
      },
    );

    assert.equal(result.status, 409);
    assert.equal(
      result.body.code,
      "PIN_IN_USE",
    );

    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "create: inactive employee PIN does not reserve the PIN",
  async () => {
    const h = harness();

    const result = await h.call(
      "CREATE",
      {
        method: "POST",
        body: {
          name: "Reuse Inactive PIN",
          role: "employee",
          pin: "4444",
        },
      },
    );

    assert.equal(result.status, 201);
  },
);

for (const body of [
  {
    name: "",
    role: "employee",
    pin: "9876",
  },
  {
    name: "X".repeat(101),
    role: "employee",
    pin: "9876",
  },
  {
    name: "Person",
    role: "admin",
    pin: "9876",
  },
  {
    name: "Person",
    role: "employee",
    pin: "123",
  },
  {
    name: "Person",
    role: "employee",
    pin: "1234567",
  },
  {
    name: "Person",
    role: "employee",
    pin: "abcd",
  },
  {
    name: "Person",
    role: "employee",
    pin: "9876",
    business_id: BUSINESS_B,
  },
  {
    name: "Person",
    role: "employee",
    pin: "9876",
    isActive: false,
  },
]) {
  test(
    `create rejects invalid/client-controlled body ${JSON.stringify(
      body,
    ).slice(0, 60)}`,
    async () => {
      const h = harness();

      const result = await h.call(
        "CREATE",
        {
          method: "POST",
          body,
        },
      );

      assert.equal(result.status, 400);
      assert.equal(
        h.serviceCreated,
        0,
      );
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    },
  );
}

test(
  "update: manager can edit ordinary employee with business-scoped mutation",
  async () => {
    const h = harness({
      role: "manager",
    });

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${EMPLOYEE_A}`,
        method: "PATCH",
        body: {
          name: "  Avery Updated ",
        },
      },
    );

    assert.equal(result.status, 200);
    assert.equal(
      result.body.employee.display_name,
      "Avery Updated",
    );
    assert.equal(
      result.body.employee.role,
      "employee",
    );

    const write =
      h.serviceWrites.find(
        (entry) =>
          entry.operation === "update",
      );

    assert.ok(write);

    assert.deepEqual(write.filters, [
      ["business_id", BUSINESS_A],
      ["id", EMPLOYEE_A],
    ]);

    assert.equal(
      write.values.updated_by_user_id,
      MEMBER_USER,
    );
  },
);

test(
  "update: manager cannot promote employee to manager or owner",
  async () => {
    for (const role of ["manager", "owner"]) {
      const h = harness({
        role: "manager",
      });

      const result = await h.call(
        "UPDATE",
        {
          url: `/team/${EMPLOYEE_A}`,
          method: "PATCH",
          body: {
            role,
          },
        },
      );

      assert.equal(result.status, 403);
      assert.equal(
        result.body.code,
        "ROLE_FORBIDDEN",
      );
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    }
  },
);

test(
  "update: manager cannot modify existing manager employee",
  async () => {
    const h = harness({
      role: "manager",
    });

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${MANAGER_A}`,
        method: "PATCH",
        body: {
          name: "Changed Manager",
        },
      },
    );

    assert.equal(result.status, 403);
    assert.equal(
      result.body.code,
      "ROLE_FORBIDDEN",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "update: manager cannot modify owner employee",
  async () => {
    const h = harness({
      role: "manager",
    });

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${OWNER_A}`,
        method: "PATCH",
        body: {
          name: "Changed Owner",
        },
      },
    );

    assert.equal(result.status, 403);
    assert.equal(
      result.body.code,
      "ROLE_FORBIDDEN",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "update: owner can promote employee to manager",
  async () => {
    const h = harness({
      role: "owner",
    });

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${EMPLOYEE_A}`,
        method: "PATCH",
        body: {
          role: "manager",
        },
      },
    );

    assert.equal(result.status, 200);
    assert.equal(
      result.body.employee.role,
      "manager",
    );
  },
);

test(
  "update: owner can modify owner employee",
  async () => {
    const h = harness({
      role: "owner",
    });

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${OWNER_A}`,
        method: "PATCH",
        body: {
          name: "Owner Updated",
        },
      },
    );

    assert.equal(result.status, 200);
    assert.equal(
      result.body.employee.display_name,
      "Owner Updated",
    );
  },
);

test(
  "update: employee is deactivated rather than deleted",
  async () => {
    const h = harness({
      role: "manager",
    });

    const before =
      h.tables.employees.length;

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${EMPLOYEE_A}`,
        method: "PATCH",
        body: {
          isActive: false,
        },
      },
    );

    assert.equal(result.status, 200);
    assert.equal(
      result.body.employee.is_active,
      false,
    );
    assert.equal(
      h.tables.employees.length,
      before,
    );
  },
);

test(
  "update: inactive employee cannot be reactivated without new PIN",
  async () => {
    const h = harness();

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${INACTIVE_A}`,
        method: "PATCH",
        body: {
          isActive: true,
        },
      },
    );

    assert.equal(result.status, 409);
    assert.equal(
      result.body.code,
      "REACTIVATION_REQUIRES_PIN",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "update: reactivation rejects PIN assigned to active employee",
  async () => {
    const h = harness();

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${INACTIVE_A}`,
        method: "PATCH",
        body: {
          isActive: true,
          pin: "1111",
        },
      },
    );

    assert.equal(result.status, 409);
    assert.equal(
      result.body.code,
      "PIN_IN_USE",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "update: reactivation atomically activates employee with fresh hashed PIN",
  async () => {
    const h = harness({
      role: "manager",
    });

    const before =
      h.tables.employees.find(
        (employee) =>
          employee.id === INACTIVE_A,
      );

    const oldHash = before.pin_hash;
    const oldSalt = before.pin_salt;

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${INACTIVE_A}`,
        method: "PATCH",
        body: {
          isActive: true,
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 200);
    assert.equal(
      result.body.employee.is_active,
      true,
    );

    const writes =
      h.serviceWrites.filter(
        (entry) =>
          entry.operation === "update",
      );

    assert.equal(writes.length, 1);

    const write = writes[0];

    assert.equal(
      write.values.is_active,
      true,
    );
    assert.notEqual(
      write.values.pin_hash,
      "9876",
    );
    assert.notEqual(
      write.values.pin_salt,
      "9876",
    );
    assert.notEqual(
      write.values.pin_hash,
      oldHash,
    );
    assert.notEqual(
      write.values.pin_salt,
      oldSalt,
    );
    assert.equal(
      write.values.updated_by_user_id,
      MEMBER_USER,
    );

    assert.deepEqual(write.filters, [
      ["business_id", BUSINESS_A],
      ["id", INACTIVE_A],
    ]);

    const serialized =
      JSON.stringify(result.body);

    assert.ok(
      !serialized.includes("pin_hash"),
    );
    assert.ok(
      !serialized.includes("pin_salt"),
    );
    assert.ok(
      !serialized.includes("9876"),
    );
  },
);

test(
  "update: PIN is rejected outside inactive employee reactivation",
  async () => {
    const h = harness();

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${EMPLOYEE_A}`,
        method: "PATCH",
        body: {
          name: "No PIN Here",
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 400);
    assert.equal(
      result.body.code,
      "INVALID_REQUEST",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "update: manager cannot reactivate an inactive manager",
  async () => {
    const inactiveManager = fixtureEmployee({
      id: MANAGER_A,
      name: "Inactive Manager",
      role: "manager",
      pin: "2222",
      active: false,
    });

    const h = harness({
      role: "manager",
      employees: [
        fixtureEmployee({
          id: EMPLOYEE_A,
          name: "Avery Employee",
          pin: "1111",
        }),
        inactiveManager,
      ],
    });

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${MANAGER_A}`,
        method: "PATCH",
        body: {
          isActive: true,
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 403);
    assert.equal(
      result.body.code,
      "ROLE_FORBIDDEN",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "update: cross-tenant employee is not exposed or mutated",
  async () => {
    const h = harness();

    const result = await h.call(
      "UPDATE",
      {
        url: `/team/${EMPLOYEE_B}`,
        method: "PATCH",
        body: {
          name: "Hijacked",
        },
      },
    );

    assert.equal(result.status, 404);
    assert.equal(
      result.body.code,
      "EMPLOYEE_NOT_FOUND",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );

    assert.equal(
      h.tables.employees.find(
        (employee) =>
          employee.id === EMPLOYEE_B,
      ).display_name,
      "Other Tenant Secret",
    );
  },
);

for (const body of [
  {},
  { name: "" },
  { role: "admin" },
  { isActive: "yes" },
  { business_id: BUSINESS_B },
]) {
  test(
    `update rejects invalid/client-controlled body ${JSON.stringify(
      body,
    )}`,
    async () => {
      const h = harness();

      const result = await h.call(
        "UPDATE",
        {
          url: `/team/${EMPLOYEE_A}`,
          method: "PATCH",
          body,
        },
      );

      assert.equal(result.status, 400);
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    },
  );
}

test(
  "update rejects malformed employee id before service access",
  async () => {
    const h = harness();

    const result = await h.call(
      "UPDATE",
      {
        url: "/team/not-a-uuid",
        method: "PATCH",
        body: {
          name: "No",
        },
      },
    );

    assert.equal(result.status, 400);
    assert.equal(
      h.serviceCreated,
      0,
    );
  },
);

test(
  "reset PIN: manager resets ordinary employee PIN without exposing secret",
  async () => {
    const h = harness({
      role: "manager",
    });

    const result = await h.call(
      "RESET_PIN",
      {
        url: `/team/${EMPLOYEE_A}/pin`,
        method: "POST",
        body: {
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 200);

    const write =
      h.serviceWrites.find(
        (entry) =>
          entry.operation === "update",
      );

    assert.ok(write);
    assert.notEqual(
      write.values.pin_hash,
      "9876",
    );
    assert.notEqual(
      write.values.pin_salt,
      "9876",
    );

    const serialized = JSON.stringify(
      result.body,
    );

    assert.ok(
      !serialized.includes("pin_hash"),
    );
    assert.ok(
      !serialized.includes("pin_salt"),
    );
    assert.ok(!serialized.includes("9876"));
  },
);

test(
  "reset PIN: duplicate active PIN is rejected",
  async () => {
    const h = harness();

    const result = await h.call(
      "RESET_PIN",
      {
        url: `/team/${MANAGER_A}/pin`,
        method: "POST",
        body: {
          pin: "1111",
        },
      },
    );

    assert.equal(result.status, 409);
    assert.equal(
      result.body.code,
      "PIN_IN_USE",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "reset PIN: employee may keep its own current PIN",
  async () => {
    const h = harness();

    const result = await h.call(
      "RESET_PIN",
      {
        url: `/team/${EMPLOYEE_A}/pin`,
        method: "POST",
        body: {
          pin: "1111",
        },
      },
    );

    assert.equal(result.status, 200);
  },
);

test(
  "reset PIN: manager cannot reset manager or owner PIN",
  async () => {
    for (const id of [
      MANAGER_A,
      OWNER_A,
    ]) {
      const h = harness({
        role: "manager",
      });

      const result = await h.call(
        "RESET_PIN",
        {
          url: `/team/${id}/pin`,
          method: "POST",
          body: {
            pin: "9876",
          },
        },
      );

      assert.equal(result.status, 403);
      assert.equal(
        result.body.code,
        "ROLE_FORBIDDEN",
      );
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    }
  },
);

test(
  "reset PIN: inactive employee must use reactivation flow",
  async () => {
    const h = harness({
      role: "manager",
    });

    const result = await h.call(
      "RESET_PIN",
      {
        url: `/team/${INACTIVE_A}/pin`,
        method: "POST",
        body: {
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 409);
    assert.equal(
      result.body.code,
      "EMPLOYEE_INACTIVE",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

test(
  "reset PIN: cross-tenant employee cannot be reached",
  async () => {
    const h = harness();

    const result = await h.call(
      "RESET_PIN",
      {
        url: `/team/${EMPLOYEE_B}/pin`,
        method: "POST",
        body: {
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 404);
    assert.equal(
      result.body.code,
      "EMPLOYEE_NOT_FOUND",
    );
    assert.equal(
      h.serviceWrites.length,
      0,
    );
  },
);

for (const body of [
  {},
  { pin: "123" },
  { pin: "1234567" },
  { pin: "abcd" },
  {
    pin: "9876",
    business_id: BUSINESS_B,
  },
]) {
  test(
    `reset PIN rejects invalid/client-controlled body ${JSON.stringify(
      body,
    )}`,
    async () => {
      const h = harness();

      const result = await h.call(
        "RESET_PIN",
        {
          url: `/team/${EMPLOYEE_A}/pin`,
          method: "POST",
          body,
        },
      );

      assert.equal(result.status, 400);
      assert.equal(
        h.serviceWrites.length,
        0,
      );
    },
  );
}

test(
  "reset PIN rejects malformed employee id before service access",
  async () => {
    const h = harness();

    const result = await h.call(
      "RESET_PIN",
      {
        url: "/team/not-a-uuid/pin",
        method: "POST",
        body: {
          pin: "9876",
        },
      },
    );

    assert.equal(result.status, 400);
    assert.equal(
      h.serviceCreated,
      0,
    );
  },
);

test(
  "service provider failure returns safe typed error without leaking provider detail",
  async () => {
    const h = harness({
      serviceDbError: "employees",
    });

    const result = await h.call(
      "DIRECTORY",
    );

    assert.equal(result.status, 503);
    assert.equal(
      result.body.code,
      "SERVICE_UNAVAILABLE",
    );

    assert.ok(
      !JSON.stringify(result.body).includes(
        "private-service-provider-detail",
      ),
    );
  },
);

test(
  "source boundary: Team authenticates member before service client and never returns secret fields",
  () => {
    const source = fs.readFileSync(
      "server/handlers/team.ts",
      "utf8",
    );

    assert.match(
      source,
      /authorizedMember\(request\)/,
    );

    assert.match(
      source,
      /createSupabaseServiceClient/,
    );

    assert.match(
      source,
      /const publicFields\s*=\s*[\s\S]*display_name[\s\S]*role[\s\S]*is_active/,
    );

    assert.ok(
      !/const publicFields\s*=[^;]*pin_hash/s.test(
        source,
      ),
    );

    assert.ok(
      !/const publicFields\s*=[^;]*pin_salt/s.test(
        source,
      ),
    );
  },
);

test(
  "migration boundary: Team security tables have no anon/authenticated grants",
  () => {
    const source = fs.readFileSync(
      "supabase/migrations/202609290001_m04_team_device_identity.sql",
      "utf8",
    );

    for (const table of [
      "employees",
      "zude_devices",
      "employee_sessions",
    ]) {
      assert.match(
        source,
        new RegExp(
          `revoke all on table public\\.${table} from anon, authenticated`,
          "i",
        ),
      );

      assert.ok(
        !new RegExp(
          `grant\\s+[^;]+on\\s+table\\s+public\\.${table}\\s+to\\s+(anon|authenticated)`,
          "i",
        ).test(source),
        `${table} must not have direct client grants`,
      );
    }
  },
);

test(
  "migration boundary: M04 tenant records cascade with business deletion",
  () => {
    const source = fs.readFileSync(
      "supabase/migrations/202609290001_m04_team_device_identity.sql",
      "utf8",
    );

    for (const table of [
      "employees",
      "zude_devices",
      "employee_sessions",
    ]) {
      assert.match(
        source,
        new RegExp(
          String.raw`create table public\.${table}[\s\S]*?business_id uuid not null references public\.businesses\(id\) on delete cascade`,
          "i",
        ),
      );
    }
  },
);

test(
  "migration boundary: auth actor references preserve records with SET NULL",
  () => {
    const source = fs.readFileSync(
      "supabase/migrations/202609290001_m04_team_device_identity.sql",
      "utf8",
    );

    for (const column of [
      "created_by_user_id",
      "updated_by_user_id",
      "registered_by_user_id",
      "revoked_by_user_id",
    ]) {
      assert.match(
        source,
        new RegExp(
          String.raw`${column} uuid references auth\.users\(id\) on delete set null`,
          "i",
        ),
      );
    }
  },
);

test(
  "migration boundary: employee sessions cascade with employee and device deletion",
  () => {
    const source = fs.readFileSync(
      "supabase/migrations/202609290001_m04_team_device_identity.sql",
      "utf8",
    );

    assert.match(
      source,
      /references public\.zude_devices \(business_id, id\)\s+on delete cascade/i,
    );

    assert.match(
      source,
      /references public\.employees \(business_id, id\)\s+on delete cascade/i,
    );
  },
);

test(
  "migration boundary: revoked device remains valid if actor account is later deleted",
  () => {
    const source = fs.readFileSync(
      "supabase/migrations/202609290001_m04_team_device_identity.sql",
      "utf8",
    );

    assert.match(
      source,
      /\(revoked_at is null and revoked_by_user_id is null\)\s+or\s+revoked_at is not null/i,
    );
  },
);


test("concurrent duplicate PIN creates cannot both commit the same verified snapshot", async () => {
  const h = harness();
  const results = await Promise.all([1, 2].map(n => h.call("CREATE", {method:"POST",body:{name:`Concurrent ${n}`,role:"employee",pin:"9876"}})));
  assert.equal(results.filter(r=>r.status===201).length,1);
  assert.ok(results.some(r=>r.status===503 || r.status===409));
  assert.equal(h.tables.employees.filter(e=>e.display_name.startsWith("Concurrent")).length,1);
});
test("migration atomic PIN guard and session invalidation are service-only", () => {
  const sql=fs.readFileSync("supabase/migrations/202609290001_m04_team_device_identity.sql","utf8");
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/current_snapshot <> expected_snapshot/);
  assert.match(sql,/existing.updated_at is distinct from p_expected_updated_at/);
  assert.match(sql,/update public.employee_sessions set revoked_at/);
  assert.match(sql,/revoke all on function public.m04_write_employee[^;]+from public, anon, authenticated/);
  assert.match(sql,/grant execute on function public.m04_write_employee[^;]+to service_role/);
  assert.match(sql,/security invoker set search_path = ''/);
});
