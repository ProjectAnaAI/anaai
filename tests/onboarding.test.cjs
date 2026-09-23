const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, imports = {}) {
  const exports = {};

  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(file, "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
        },
      }
    ).outputText,
    {
      exports,

      require: (name) => {
        if (
          Object.prototype.hasOwnProperty.call(
            imports,
            name
          )
        ) {
          return imports[name];
        }

        throw new Error(
          `Unexpected test import: ${name}`
        );
      },

      Response,

      process: {
        env: {
          NEXT_PUBLIC_SUPABASE_URL: "test",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "test",
        },
      },

      console: {
        error() {},
      },

      Intl,
      Error,
    }
  );

  return exports;
}

const businessHours = load(
  "lib/business-hours.ts"
);

const validation = load(
  "lib/onboarding.ts",
  {
    "@/lib/business-hours": businessHours,
  }
);

function draft() {
  const value =
    validation.newOnboardingDraft();

  value.name = "Test Business";
  value.phone = "(555) 123-4567";
  value.email = "owner@example.com";
  value.address = "123 Test Street";
  value.services[0].name = "Service";

  return value;
}

test(
  "required business details with optional service price accepted",
  () => {
    const value = draft();

    value.services[0].price = "";
    value.services[0].description = "";

    assert.doesNotThrow(() =>
      validation.validateOnboarding(
        value
      )
    );
  }
);

for (const [name, mutate] of [
  [
    "missing business name rejected",
    (value) => {
      value.name = "";
    },
  ],

  [
    "missing business phone rejected",
    (value) => {
      value.phone = "";
    },
  ],

  [
    "invalid business phone rejected",
    (value) => {
      value.phone = "123";
    },
  ],

  [
    "missing business email rejected",
    (value) => {
      value.email = "";
    },
  ],

  [
    "invalid business email rejected",
    (value) => {
      value.email = "not-an-email";
    },
  ],

  [
    "missing business address rejected",
    (value) => {
      value.address = "";
    },
  ],

  [
    "invalid business hours rejected",
    (value) => {
      value.hours.monday.close =
        "08:00";
    },
  ],

  [
    "invalid closed flag rejected",
    (value) => {
      value.hours.monday.closed =
        "false";
    },
  ],

  [
    "missing services rejected",
    (value) => {
      value.services = [];
    },
  ],

  [
    "zero service duration rejected",
    (value) => {
      value.services[0].duration =
        "0";
    },
  ],

  [
    "decimal service duration rejected",
    (value) => {
      value.services[0].duration =
        "1.5";
    },
  ],

  [
    "negative service price rejected",
    (value) => {
      value.services[0].price =
        "-1";
    },
  ],

  [
    "missing greeting rejected",
    (value) => {
      value.greeting = "";
    },
  ],
]) {
  test(name, () => {
    const value = draft();

    mutate(value);

    assert.throws(() =>
      validation.validateOnboarding(
        value
      )
    );
  });
}

function api({
  user = true,

  result = {
    success: true,
  },

  error = null,
} = {}) {
  const calls = [];

  const route = load(
    "server/handlers/onboarding.ts",
    {
      "@/lib/onboarding":
        validation,


      "@supabase/supabase-js": {
        createClient: (
          _url,
          _key,
          options
        ) => {
          calls.push(options);

          return {
            auth: {
              getUser:
                async () => ({
                  data: {
                    user: user
                      ? {}
                      : null,
                  },
                }),
            },

            rpc: async (
              name,
              args
            ) => {
              calls.push({
                name,
                args,
              });

              return {
                data: result,
                error,
              };
            },
          };
        },
      },
    }
  );

  return {
    calls,

    post: (
      body = draft(),
      token = true
    ) =>
      route
        .POST({
          headers: {
            get: () =>
              token
                ? "Bearer test-token"
                : null,
          },

          json: async () =>
            body,
        })
        .then(async (response) => ({
          status: response.status,
          body: await response.json(),
        })),
  };
}

test(
  "missing/invalid auth blocks provisioning",
  async () => {
    for (const harness of [
      api({
        user: false,
      }),
      api(),
    ]) {
      const response =
        await harness.post(
          draft(),
          false
        );

      assert.equal(
        response.status,
        401
      );

      assert.equal(
        harness.calls.length,
        0
      );
    }

    assert.equal(
      (
        await api({
          user: false,
        }).post()
      ).status,
      401
    );
  }
);

test(
  "caller JWT attached; browser identities never forwarded",
  async () => {
    const harness = api();

    const response =
      await harness.post({
        ...draft(),

        user_id: "untrusted",
        business_id: "untrusted",
      });

    assert.equal(
      response.body.success,
      true
    );

    assert.equal(
      harness.calls[0].global
        .headers.Authorization,
      "Bearer test-token"
    );

    assert.equal(
      harness.calls[1].name,
      "create_business_for_current_user"
    );

    assert.equal(
      harness.calls[1].args
        .p_setup.user_id,
      undefined
    );

    assert.equal(
      harness.calls[1].args
        .p_setup.business_id,
      undefined
    );
  }
);

test(
  "invalid draft never invokes RPC",
  async () => {
    const harness = api();

    const response =
      await harness.post({
        ...draft(),
        services: [],
      });

    assert.equal(
      response.status,
      400
    );

    // Supabase client may be initialized,
    // but the RPC itself must not run.
    assert.equal(
      harness.calls.length,
      1
    );
  }
);

test(
  "missing required business details never invoke RPC",
  async () => {
    for (const key of [
      "phone",
      "email",
      "address",
    ]) {
      const harness = api();
      const body = draft();

      body[key] = "";

      const response =
        await harness.post(
          body
        );

      assert.equal(
        response.status,
        400
      );

      assert.equal(
        harness.calls.length,
        1
      );
    }
  }
);

test(
  "duplicate setup reconciles without reporting a new creation",
  async () => {
    const response =
      await api({
        result: {
          success: false,
          code:
            "ALREADY_PROVISIONED",
        },
      }).post();

    assert.equal(
      response.status,
      409
    );

    assert.equal(
      response.body.code,
      "ALREADY_PROVISIONED"
    );

    assert.equal(
      response.body.success,
      undefined
    );
  }
);

test(
  "failed provisioning never reports success or leaks errors",
  async () => {
    for (const options of [
      {
        error: {
          message:
            "private",
        },
      },

      {
        result: {
          success: false,
          code:
            "INTERNAL_ERROR",
        },
      },

      {
        result: {
          success: false,
          code:
            "INVALID_SETUP",
        },
      },
    ]) {
      const response =
        await api(
          options
        ).post();

      assert.ok(
        response.status >=
          400
      );

      assert.notEqual(
        response.body.success,
        true
      );

      assert.ok(
        !JSON.stringify(
          response
        ).includes(
          "private"
        )
      );
    }
  }
);

// Keep the original migration as deployment history.
const originalSql =
  fs.readFileSync(
    "supabase/migrations/202609150001_secure_business_onboarding.sql",
    "utf8"
  );

// This migration contains the stricter onboarding contract.
const requiredDetailsSql =
  fs.readFileSync(
    "supabase/migrations/202609150002_require_onboarding_business_details.sql",
    "utf8"
  );

test(
  "SQL contract: auth-owned bootstrap, serialized duplicate guard, atomic exception boundary",
  () => {
    assert.match(
      requiredDetailsSql,
      /v_user uuid := auth.uid\(\)/
    );

    assert.ok(
      requiredDetailsSql.indexOf(
        "pg_advisory_xact_lock"
      ) <
        requiredDetailsSql.indexOf(
          "if exists"
        )
    );

    assert.ok(
      requiredDetailsSql.indexOf(
        "ALREADY_PROVISIONED"
      ) <
        requiredDetailsSql.indexOf(
          "insert into public.businesses"
        )
    );

    assert.match(
      requiredDetailsSql,
      /values \(\s*v_business,\s*v_user,\s*'owner'\s*\)/
    );

    assert.match(
      requiredDetailsSql,
      /security definer\s+set search_path = pg_catalog, public/
    );

    assert.match(
      requiredDetailsSql,
      /from public, anon/
    );

    assert.match(
      requiredDetailsSql,
      /to authenticated/
    );

    assert.equal(
      (
        requiredDetailsSql.match(
          /if not found then\s+raise exception 'provisioning write failed';\s+end if;/g
        ) || []
      ).length,
      5
    );

    assert.ok(
      !/disable row level|create policy/i.test(
        requiredDetailsSql
      )
    );
  }
);

test(
  "SQL requires phone, email and address before provisioning",
  () => {
    assert.match(
      requiredDetailsSql,
      /btrim\(p_setup ->> 'phone'\) = ''/
    );

    assert.match(
      requiredDetailsSql,
      /btrim\(p_setup ->> 'email'\) = ''/
    );

    assert.match(
      requiredDetailsSql,
      /btrim\(p_setup ->> 'address'\) = ''/
    );

    const validationEnd =
      requiredDetailsSql.indexOf(
        "insert into public.businesses"
      );

    assert.ok(
      requiredDetailsSql.indexOf(
        "btrim(p_setup ->> 'phone') = ''"
      ) < validationEnd
    );

    assert.ok(
      requiredDetailsSql.indexOf(
        "btrim(p_setup ->> 'email') = ''"
      ) < validationEnd
    );

    assert.ok(
      requiredDetailsSql.indexOf(
        "btrim(p_setup ->> 'address') = ''"
      ) < validationEnd
    );
  }
);

test(
  "SQL contract: profile, services and AI settings use only generated business and auth user",
  () => {
    for (const table of [
      "business_profiles",
      "services",
      "ai_settings",
    ]) {
      assert.match(
        requiredDetailsSql,
        new RegExp(
          `insert into public.${table}[\\s\\S]*?values \\(\\s*v_business,\\s*v_user`
        )
      );
    }
  }
);

test(
  "original onboarding migration remains preserved as deployment history",
  () => {
    assert.match(
      originalSql,
      /create or replace function public\.create_business_for_current_user/
    );

    assert.match(
      requiredDetailsSql,
      /create or replace function public\.create_business_for_current_user/
    );
  }
);

const page =
  fs.readFileSync(
    "app/onboarding/page.tsx",
    "utf8"
  );

const provider =
  fs.readFileSync(
    "components/layout/ActiveBusinessProvider.tsx",
    "utf8"
  );

test(
  "routing contract: anonymous login, zero memberships onboarding, existing onboarding visitor dashboard",
  () => {
    assert.match(
      provider,
      /if \(!userId\) \{\s*router\.replace\(["']\/login["']\)/
    );

    assert.match(
      provider,
      /if \(!memberships\?\.length\)[\s\S]*?router\.replace\(["']\/onboarding["']\)/
    );

    assert.match(
      provider,
      /if \(isOnboarding\) router\.replace\(["']\/dashboard["']\)/
    );
  }
);

test(
  "wizard contract: duplicate latch, explicit success, draft persistence, fresh membership discovery",
  () => {
    // Formatting-independent check for the
    // duplicate submission guard.
    assert.match(
      page,
      /if\s*\(\s*submitting\.current\s*\)\s*\{\s*return;\s*\}/
    );

    assert.match(
      page,
      /response\.ok\s*&&\s*result\.success\s*===\s*true/
    );

    assert.match(
      page,
      /sessionStorage\.setItem\s*\(/
    );

    // Current onboarding redirects with replace()
    // rather than adding /dashboard to browser history.
    assert.match(
      page,
      /window\.location\.replace\s*\(\s*["']\/dashboard["']\s*\)/
    );

    assert.match(
      page,
      /ALREADY_PROVISIONED/
    );

    // Provisioning readiness is verified by
    // rediscovering the current business.
    assert.match(
      page,
      /["']\/api\/current-business["']/
    );
  }
);

test(
  "wizard marks phone, email and address as required",
  () => {
    assert.match(
      page,
      /field\(\s*["']phone["']\s*,\s*["']Phone \*["']\s*,\s*["']tel["']\s*\)/
    );

    assert.match(
      page,
      /field\(\s*["']email["']\s*,\s*["']Email \*["']\s*,\s*["']email["']\s*\)/
    );

    assert.match(
      page,
      /field\(\s*["']address["']\s*,\s*["']Address \*["']\s*\)/
    );

    assert.match(
      page,
      /if\s*\(\s*!draft\.phone\.trim\(\)\s*\)/
    );

    assert.match(
      page,
      /if\s*\(\s*!draft\.email\.trim\(\)\s*\)/
    );

    assert.match(
      page,
      /if\s*\(\s*!draft\.address\.trim\(\)\s*\)/
    );
  }
);

test(
  "corrupt saved drafts are rejected before render",
  () => {
    assert.equal(
      validation.isOnboardingDraft({
        ...draft(),
        services: [
          null,
        ],
      }),
      false
    );

    assert.equal(
      validation.isOnboardingDraft({
        ...draft(),
        hours: {},
      }),
      false
    );

    assert.equal(
      validation.isOnboardingDraft(
        draft()
      ),
      true
    );
  }
);

test(
  "SQL rejects stale-snapshot isolation before provisioning lock",
  () => {
    assert.ok(
      requiredDetailsSql.indexOf(
        "current_setting('transaction_isolation')"
      ) <
        requiredDetailsSql.indexOf(
          "pg_advisory_xact_lock"
        )
    );

    assert.match(
      requiredDetailsSql,
      /UNSUPPORTED_ISOLATION/
    );
  }
);
// Milestone 12, checkpoint 2: owner-selected simultaneous capacity.
test('new onboarding draft defaults to numeric capacity 1', () => {
  assert.equal(validation.newOnboardingDraft().appointment_capacity, 1);
});

test('older session draft restores capacity 1 through the existing defaults merge', () => {
  const legacy = draft();
  delete legacy.appointment_capacity;
  const saved = JSON.parse(JSON.stringify(legacy));
  const restored = { ...validation.newOnboardingDraft(), ...saved };
  assert.equal(validation.isOnboardingDraft(restored), true);
  assert.equal(validation.validateOnboarding(restored).appointment_capacity, 1);
  assert.equal(restored.name, legacy.name);
  assert.match(page, /const restored = \{\s*\.\.\.newOnboardingDraft\(\),\s*\.\.\.parsed,\s*\}/);
});

for (const capacity of [1, 7, 100]) {
  test(`capacity ${capacity} is validated and explicitly sent to the provisioning RPC`, async () => {
    const body = { ...draft(), appointment_capacity: capacity };
    const validated = validation.validateOnboarding(body);
    assert.equal(validated.appointment_capacity, capacity);
    assert.equal(Number.isInteger(validated.appointment_capacity), true);
    const h = api();
    assert.equal((await h.post(body)).status, 200);
    assert.equal(h.calls[1].args.p_setup.appointment_capacity, capacity);
  });
}

for (const [label, capacity] of [
  ['zero', 0], ['above maximum', 101], ['negative', -1], ['fractional', 1.5],
  ['string', '2'], ['empty string', ''], ['null', null], ['missing', undefined],
  ['boolean', true], ['array', [2]], ['object', { value: 2 }],
  ['NaN', NaN], ['infinity', Infinity],
]) {
  test(`${label} capacity is rejected by draft validation and API without coercion or clamping`, async () => {
    const body = { ...draft(), appointment_capacity: capacity };
    if (capacity === undefined) delete body.appointment_capacity;
    assert.equal(validation.isOnboardingDraft(body), false);
    assert.throws(() => validation.validateOnboarding(body));
    if (capacity !== undefined) {
      const restored = { ...validation.newOnboardingDraft(), ...body };
      assert.equal(validation.isOnboardingDraft(restored), false, 'defaults must not overwrite a malformed saved capacity');
    }
    const h = api();
    assert.equal((await h.post(body)).status, 400);
    assert.equal(h.calls.length, 1, 'authentication may run, but no provisioning RPC');
    assert.equal(body.appointment_capacity, capacity, 'invalid submission is not modified');
  });
}

test('capacity provisioning keeps a strict allowlist including nested service fields', async () => {
  const h = api();
  const body = { ...draft(), appointment_capacity: 8, user_id: 'untrusted', business_id: 'untrusted',
    role: 'owner', arbitrary: 'untrusted' };
  Object.assign(body.services[0], { user_id: 'untrusted', business_id: 'untrusted', arbitrary: 'untrusted' });
  assert.equal((await h.post(body)).status, 200);
  const setup = h.calls[1].args.p_setup;
  assert.deepEqual(Object.keys(setup).sort(), ['name', 'phone', 'email', 'address', 'timezone',
    'appointment_capacity', 'hours', 'services', 'receptionist', 'greeting'].sort());
  assert.deepEqual(Object.keys(setup.services[0]).sort(), ['name', 'duration', 'price', 'description'].sort());
  assert.equal(setup.appointment_capacity, 8);
  assert.ok(!JSON.stringify(setup).includes('untrusted'));
});

const timezoneSql = fs.readFileSync('supabase/migrations/202609180003_business_timezone_and_hours.sql', 'utf8');
const capacityColumnSql = fs.readFileSync('supabase/migrations/202609210001_add_appointment_capacity.sql', 'utf8');
const capacityOnboardingSql = fs.readFileSync('supabase/migrations/202609220001_onboarding_appointment_capacity.sql', 'utf8');

test('SQL capacity contract rejects missing/null/string and fractional/out-of-range numbers before any writes', () => {
  assert.match(capacityOnboardingSql, /jsonb_typeof\(p_setup -> 'appointment_capacity'\) is distinct from 'number'/);
  assert.match(capacityOnboardingSql, /v_capacity := \(p_setup ->> 'appointment_capacity'\)::numeric;/);
  assert.match(capacityOnboardingSql, /if v_capacity <> trunc\(v_capacity\) or v_capacity not between 1 and 100 then\s*raise exception 'invalid';/);
  const writes = capacityOnboardingSql.indexOf('insert into public.businesses');
  const capacityCheck = capacityOnboardingSql.indexOf("jsonb_typeof(p_setup -> 'appointment_capacity')");
  const invalidSetup = capacityOnboardingSql.indexOf("'code', 'INVALID_SETUP'");
  assert.ok(capacityCheck > 0 && capacityCheck < invalidSetup && invalidSetup < writes);
  assert.doesNotMatch(capacityOnboardingSql, /coalesce\([^;]*appointment_capacity|greatest\(|least\(/i);
  assert.match(capacityOnboardingSql, /insert into public.businesses \(\s*name,\s*timezone,\s*appointment_capacity\s*\)\s*values \(\s*btrim\(p_setup ->> 'name'\),\s*v_timezone,\s*v_capacity::integer\s*\)\s*returning id into v_business;/);
});

test('new provisioning RPC preserves the complete latest function apart from capacity validation and insertion', () => {
  const body = sql => sql.slice(sql.indexOf('create or replace function'), sql.indexOf('$function$;') + '$function$;'.length);
  const withoutCapacity = body(capacityOnboardingSql)
    .replace('  v_capacity numeric;\n', '')
    .replace(/    -- Require a JSON number[^]*?(?=    foreach v_field)/, '')
    .replace('    timezone,\n    appointment_capacity\n', '    timezone\n')
    .replace('    v_timezone,\n    v_capacity::integer\n', '    v_timezone\n');
  assert.equal(withoutCapacity, body(timezoneSql));
  // Replacing the same function retains the ACL established by 202609150002.
  assert.match(capacityOnboardingSql, /create or replace function public\.create_business_for_current_user\(p_setup jsonb\)/);
  assert.doesNotMatch(capacityOnboardingSql, /drop function|grant |revoke |create policy|alter table/i);
  assert.match(requiredDetailsSql, /revoke all\s+on function public\.create_business_for_current_user\(jsonb\)\s+from public, anon/);
  assert.match(requiredDetailsSql, /grant execute\s+on function public\.create_business_for_current_user\(jsonb\)\s+to authenticated/);
});

test('historical timezone and capacity migrations remain byte-for-byte preserved', () => {
  const hash = text => require('node:crypto').createHash('sha256').update(text).digest('hex');
  assert.equal(hash(timezoneSql), '8994d6f481a6116dfbdb8dc031dc5e5def4d7685bb21ed5d61a96dc01473afdb');
  assert.equal(hash(capacityColumnSql), '9f08d4d8db29d91d8f1ce51be5b329477f3326935a1d1a336a319e8b59745692');
});

test('onboarding capacity uses accessible touch controls in the existing Hours step and appears in review', () => {
  const controlStart = page.indexOf('How many customers can you usually serve at the same time?');
  assert.ok(controlStart > page.indexOf('{step === 1 && (') && controlStart < page.indexOf('{step === 2 && ('));
  assert.match(page, /This sets how many appointments can overlap at your business\./);
  for (const label of ['Decrease appointment capacity', 'Increase appointment capacity']) {
    assert.ok(page.includes(`aria-label="${label}"`));
  }
  assert.match(page, /disabled=\{busy \|\| !capacityIsValid \|\| draft\.appointment_capacity <= 1\}/);
  assert.match(page, /disabled=\{busy \|\| !capacityIsValid \|\| draft\.appointment_capacity >= 100\}/);
  assert.match(page, /id="appointment-capacity"\s+type="number"\s+inputMode="numeric"/);
  assert.match(page, /min=\{1\}\s+max=\{100\}\s+step=\{1\}/);
  assert.match(page, /aria-describedby="appointment-capacity-help appointment-capacity-range"/);
  assert.ok(page.indexOf('Simultaneous capacity: {draft.appointment_capacity}') > page.indexOf('{step === 4 && ('));
  const controls = page.slice(page.indexOf('{step === 1 && ('), page.indexOf('Weekly hours'));
  assert.equal((controls.match(/size-11 shrink-0/g) || []).length, 2);
  assert.match(controls, /min-h-11 w-20 min-w-0/);
  assert.match(controls, /flex flex-wrap items-center/);
  assert.match(page, /function validateHoursStep\(\) \{\s*if \(!capacityIsValid\)/);
});
