const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function fn(file, name, context) {
  const source = fs.readFileSync(file, "utf8");

  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  let text;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === name
    ) {
      text = node.getText(ast);
    }

    ts.forEachChild(node, visit);
  }

  visit(ast);

  assert.ok(text);

  vm.createContext(context);

  vm.runInContext(
    ts.transpile(text),
    context
  );

  return context[name];
}

function bookingHarness({
  customers = [],
  selected = "",
  conflict = false,
} = {}) {
  let creates = 0;
  let books = 0;

  const notices = [];

  const ctx = {
    createInFlight: {
      current: false,
    },

    businessId: "business",
    userId: "user",

    customers,

    services: [
      {
        id: "service",
      },
    ],

    createForm: {
      customerId: selected,
      serviceId: "service",
      appointmentDate: "2026-10-05",
      appointmentTime: "10:00",
      notes: "",
    },

    customerName: "Example",
    customerPhone: "",
    customerEmail: "",

    normalizeCustomerName: (value) =>
      value.trim().toLowerCase(),

    normalizeCustomerPhone: (value) =>
      value.replace(/[^0-9]/g, ""),

    setSubmitting() {},

    showNotice: (kind) =>
      notices.push(kind),

    saveCustomer: async () => {
      creates += 1;

      return {
        id: "new",
        full_name: "Example",
        phone: null,
        email: null,
      };
    },

    setCustomers: (update) => {
      ctx.customers = update(
        ctx.customers
      );
    },

    selectCreateCustomer: (customer) => {
      ctx.createForm = {
        ...ctx.createForm,
        customerId: customer.id,
      };
    },

    sendAppointmentUpdate: async () => {
      books += 1;

      if (conflict) {
        throw Error("Slot conflict");
      }

      return {
        success: true,
      };
    },

    setCreateForm: (value) => {
      ctx.createForm = value;
    },

    setCustomerName() {},
    setCustomerPhone() {},
    setCustomerEmail() {},

    emptyForm: {},

    loadAppointments: async () => {},

    Error,
  };

  const save = fn(
    "app/appointments/page.tsx",
    "handleCreateAppointment",
    ctx
  );

  return {
    ctx,
    save,
    notices,

    counts: () => ({
      creates,
      books,
    }),

    allowBooking: () => {
      conflict = false;
    },
  };
}

test(
  "name-only prospective customer is created on save and then booked",
  async () => {
    const harness =
      bookingHarness();

    assert.equal(
      harness.counts().creates,
      0
    );

    await harness.save();

    assert.deepEqual(
      harness.counts(),
      {
        creates: 1,
        books: 1,
      }
    );

    assert.deepEqual(
      harness.notices,
      ["success"]
    );
  }
);

test(
  "customer survives conflict and retry does not create another",
  async () => {
    const harness =
      bookingHarness({
        conflict: true,
      });

    await harness.save();

    assert.deepEqual(
      harness.notices,
      ["error"]
    );

    assert.equal(
      harness.ctx.createForm.customerId,
      "new"
    );

    harness.allowBooking();

    await harness.save();

    assert.deepEqual(
      harness.counts(),
      {
        creates: 1,
        books: 2,
      }
    );

    assert.deepEqual(
      harness.notices,
      ["error", "success"]
    );
  }
);

test(
  "same-name suggestions do not silently merge customers",
  async () => {
    const harness =
      bookingHarness({
        customers: [
          {
            id: "first",
            full_name: "Example",
          },
          {
            id: "second",
            full_name: "Example",
          },
        ],
      });

    await harness.save();

    assert.equal(
      harness.counts().creates,
      1
    );
  }
);

test(
  "explicit selection uses existing customer",
  async () => {
    const harness =
      bookingHarness({
        customers: [
          {
            id: "first",
            full_name: "Example",
            phone: null,
          },
        ],
        selected: "first",
      });

    await harness.save();

    assert.deepEqual(
      harness.counts(),
      {
        creates: 0,
        books: 1,
      }
    );
  }
);

test(
  "same-tick double submit creates/books only once",
  async () => {
    const harness =
      bookingHarness();

    await Promise.all([
      harness.save(),
      harness.save(),
    ]);

    assert.deepEqual(
      harness.counts(),
      {
        creates: 1,
        books: 1,
      }
    );
  }
);

test(
  "missing business prevents creation and booking",
  async () => {
    const harness =
      bookingHarness();

    harness.ctx.businessId = null;

    await harness.save();

    assert.deepEqual(
      harness.counts(),
      {
        creates: 0,
        books: 0,
      }
    );
  }
);

test(
  "name suggestions preserve duplicates and phone exact match takes priority",
  () => {
    const ctx = {
      normalizeCustomerName: (value) =>
        value.trim().toLowerCase(),

      normalizeCustomerPhone: (value) =>
        value.replace(
          /[^0-9]/g,
          ""
        ),
    };

    const matches = fn(
      "app/appointments/page.tsx",
      "findCustomerMatches",
      ctx
    );

    const rows = [
      {
        id: "first",
        full_name: "Example",
        phone: "123-456-7890",
      },
      {
        id: "second",
        full_name: "Example",
        phone: null,
      },
    ];

    assert.equal(
      matches(
        rows,
        " example ",
        ""
      ).length,
      2
    );

    assert.equal(
      matches(
        rows,
        "",
        "1234567890"
      )[0].id,
      "first"
    );
  }
);

test(
  "service edit payload excludes duration, tenant and legacy owner",
  async () => {
    const exports = {};

    vm.runInNewContext(
      ts.transpileModule(
        fs.readFileSync(
          "lib/service-validation.ts",
          "utf8"
        ),
        {
          compilerOptions: {
            module:
              ts.ModuleKind.CommonJS,
          },
        }
      ).outputText,
      {
        exports,
      }
    );

    const filters = [];

    let payload;

    const query = {
      update: (value) => {
        payload = value;
        return query;
      },

      eq: (key, value) => {
        filters.push([
          key,
          value,
        ]);

        return query;
      },

      select: () =>
        query,

      single: async () => ({
        data: {
          id: "service",
          name: "Updated",
          duration_minutes: 30,
          price: 10,
          description: "Info",
          is_active: true,
        },
      }),
    };

    const ctx = {
      canManageServices: true,

      businessId: "business",
      userId: "user",

      saveInFlight: {
        current: false,
      },

      setSaving() {},
      setFeedback() {},

      toast: {
        error() {},
        success() {},
      },

      activeBusinessHeaders: () => ({
        "x-anaai-business-id":
          "business",
      }),

      validateService:
        exports.validateService,

      name: "Updated",
      durationMinutes: "30",
      price: "10",
      description: "Info",
      active: true,
      editingId: "service",

      supabase: {
        from: () => query,
      },

      setServices() {},

      resetEditor() {},

      Error,
    };

    await fn(
      "app/services/page.tsx",
      "handleSubmit",
      ctx
    )({
      preventDefault() {},
    });

    assert.deepEqual(
      filters,
      [
        ["id", "service"],
        [
          "business_id",
          "business",
        ],
      ]
    );

    assert.equal(
      payload.duration_minutes,
      undefined
    );

    assert.equal(
      payload.user_id,
      undefined
    );

    assert.equal(
      payload.business_id,
      undefined
    );

    assert.equal(
      payload.name,
      "Updated"
    );
  }
);

test(
  "service validation rejects unsafe numeric inputs",
  () => {
    const exports = {};

    vm.runInNewContext(
      ts.transpileModule(
        fs.readFileSync(
          "lib/service-validation.ts",
          "utf8"
        ),
        {
          compilerOptions: {
            module:
              ts.ModuleKind.CommonJS,
          },
        }
      ).outputText,
      {
        exports,
      }
    );

    for (const overrides of [
      {
        duration: "-1",
      },
      {
        duration: "1.5",
      },
      {
        duration: "Infinity",
      },
      {
        price: "-1",
      },
      {
        price: "NaN",
      },
      {
        name: "",
      },
    ]) {
      assert.throws(() =>
        exports.validateService({
          name: "Service",
          duration: "30",
          price: "1",
          description: "",
          active: true,
          ...overrides,
        })
      );
    }
  }
);