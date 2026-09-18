const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function loadUnderstanding({
  response,
  status = 'completed',
  throws = false,
} = {}) {
  const requests = [];
  const logs = [];

  class OpenAI {
    constructor(options) {
      assert.equal(options.maxRetries, 0);
      assert.equal(options.timeout, 4500);
    }

    responses = {
      create: async request => {
        requests.push(request);

        if (throws) {
          throw new Error('PRIVATE');
        }

        return {
          status,
          output_text:
            response === undefined
              ? JSON.stringify({
                  meaningful: false,
                  service_name: null,
                  date_expression: null,
                  time_expression: null,
                  confirmation: null,
                  correction: false,
                })
              : typeof response === 'string'
                ? response
                : JSON.stringify(response),
        };
      },
    };
  }

  const exports = {};

  vm.runInNewContext(
    ts.transpileModule(
      fs.readFileSync(
        'lib/voice-understanding.ts',
        'utf8'
      ),
      {
        compilerOptions: {
          module:
            ts.ModuleKind.CommonJS,

          target:
            ts.ScriptTarget.ES2022,
        },
      }
    ).outputText,
    {
      exports,

      require: name => {
        if (
          name ===
          'server-only'
        ) {
          return {};
        }

        if (
          name ===
          'openai'
        ) {
          return {
            default: OpenAI,
          };
        }

        throw new Error(
          `Unexpected dependency ${name}`
        );
      },

      process: {
        env: {
          OPENAI_API_KEY:
            'dummy-key',
        },
      },

      console: {
        error: (...args) =>
          logs.push(args),

        warn: (...args) =>
          logs.push(args),

        log: (...args) =>
          logs.push(args),

        info: (...args) =>
          logs.push(args),
      },

      JSON,
      Date,
      Set,
    }
  );

  return {
    module: exports,
    requests,
    logs,
  };
}

const SERVICES = [
  'Facial',
  'Haircut',
  'Waxing',
];

test(
  'natural multi-detail service speech preserves structured meaning',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name:
            'Facial',
          date_expression:
            'tomorrow',
          time_expression:
            'two thirty in the afternoon',
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'I want a facial tomorrow at two thirty in the afternoon.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'service'
    );

    assert.equal(
      result.meaningful,
      true
    );

    assert.equal(
      result.serviceName,
      'Facial'
    );

    assert.equal(
      result.dateExpression,
      'tomorrow'
    );

    assert.equal(
      result.timeExpression,
      'two thirty in the afternoon'
    );

    assert.equal(
      result.confirmation,
      null
    );

    assert.equal(
      result.correction,
      false
    );
  }
);

test(
  'date stage can extract date and time from one natural sentence',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression:
            'October second',
          time_expression:
            'four thirty PM',
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage: 'date',

          speech:
            'October second at four thirty PM.',
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      true
    );

    assert.equal(
      result.dateExpression,
      'October second'
    );

    assert.equal(
      result.timeExpression,
      'four thirty PM'
    );

    assert.equal(
      result.serviceName,
      null
    );
  }
);

test(
  'time stage retains extracted natural time expression',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression:
            '2:30 in the afternoon',
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage: 'time',

          speech:
            'Make it around 2:30 in the afternoon.',
        });

    assert.equal(
      result.meaningful,
      true
    );

    assert.equal(
      result.timeExpression,
      '2:30 in the afternoon'
    );

    assert.equal(
      result.confirmation,
      null
    );
  }
);

test(
  'clear confirmation is represented as backward-compatible confirmation result',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression: null,
          confirmation:
            'yes',
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Yeah, go ahead.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'confirmation'
    );

    assert.equal(
      result.confirmation,
      'yes'
    );

    assert.equal(
      result.value,
      'yes'
    );

    assert.equal(
      result.correction,
      false
    );
  }
);

test(
  'clear rejection is represented as backward-compatible negative confirmation',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression: null,
          confirmation:
            'no',
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'No, cancel it.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'confirmation'
    );

    assert.equal(
      result.confirmation,
      'no'
    );

    assert.equal(
      result.value,
      'no'
    );
  }
);

test(
  'time correction never becomes booking authorization',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression:
            'five PM',
          confirmation: null,
          correction: true,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Actually make it five PM.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.correction,
      true
    );

    assert.equal(
      result.timeExpression,
      'five PM'
    );

    assert.equal(
      result.confirmation,
      null
    );
  }
);

test(
  'confirmation-stage booking language with replacement time remains a correction',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression:
            '3:30 in the afternoon',
          confirmation: null,
          correction: true,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Book for me for 3:30 in the afternoon.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.correction,
      true
    );

    assert.equal(
      result.timeExpression,
      '3:30 in the afternoon'
    );

    assert.equal(
      result.confirmation,
      null
    );

    assert.match(
      h.requests[0].instructions,
      /supplying a replacement service, date, or time is a correction/
    );

    assert.match(
      h.requests[0].instructions,
      /book for me for three thirty in the afternoon/
    );
  }
);

test(
  'service correction never becomes booking authorization',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name:
            'Haircut',
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: true,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Actually make that a haircut.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.serviceName,
      'Haircut'
    );

    assert.equal(
      result.correction,
      true
    );

    assert.equal(
      result.confirmation,
      null
    );
  }
);

test(
  'date and time correction can carry both replacement fields',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression:
            'next Friday',
          time_expression:
            'three in the afternoon',
          confirmation: null,
          correction: true,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Wait, make it next Friday at three in the afternoon.',

          services:
            SERVICES,
        });

    assert.equal(
      result.correction,
      true
    );

    assert.equal(
      result.dateExpression,
      'next Friday'
    );

    assert.equal(
      result.timeExpression,
      'three in the afternoon'
    );

    assert.equal(
      result.confirmation,
      null
    );
  }
);

test(
  'ambiguous confirmation cannot authorize booking',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: false,
          service_name: null,
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Maybe.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );

    assert.equal(
      result.confirmation,
      null
    );
  }
);

test(
  'unrelated transcript returns no appointment meaning',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: false,
          service_name: null,
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'Turn the television up.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );

    assert.equal(
      result.serviceName,
      null
    );

    assert.equal(
      result.dateExpression,
      null
    );

    assert.equal(
      result.timeExpression,
      null
    );

    assert.equal(
      result.confirmation,
      null
    );

    assert.equal(
      result.correction,
      false
    );
  }
);

test(
  'model cannot invent a service outside server supplied services',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name:
            'Massage',
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'I want a massage.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.serviceName,
      null
    );

    assert.equal(
      result.confirmation,
      null
    );
  }
);

test(
  'correction and confirmation in the same model result fails closed',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression:
            'five PM',
          confirmation:
            'yes',
          correction: true,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Yes, but actually make it five PM.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );

    assert.equal(
      result.confirmation,
      null
    );

    assert.equal(
      result.correction,
      false
    );
  }
);

test(
  'meaningful false with extracted appointment fields fails closed',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: false,
          service_name:
            'Facial',
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'Facial.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );

    assert.equal(
      result.serviceName,
      null
    );
  }
);

test(
  'meaningful true without any structured meaning fails closed',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name: null,
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'Something unclear.',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );
  }
);

test(
  'malformed JSON fails closed',
  async () => {
    const h =
      loadUnderstanding({
        response:
          '{not-json',
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'Facial',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );
  }
);

test(
  'unexpected structured output properties fail closed',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name:
            'Facial',
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,

          unauthorized:
            'book it',
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'Facial',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );
  }
);

test(
  'model failure fails closed without exposing private error text',
  async () => {
    const h =
      loadUnderstanding({
        throws: true,
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'confirm',

          speech:
            'yes',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.confirmation,
      null
    );

    assert.equal(
      JSON.stringify(
        h.logs
      ).includes(
        'PRIVATE'
      ),
      false
    );
  }
);

test(
  'incomplete model response fails closed',
  async () => {
    const h =
      loadUnderstanding({
        status:
          'incomplete',

        response: {
          meaningful: true,
          service_name:
            'Facial',
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'Facial',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      result.meaningful,
      false
    );
  }
);

test(
  'empty caller speech never invokes the semantic model',
  async () => {
    const h =
      loadUnderstanding();

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            '   ',

          services:
            SERVICES,
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      h.requests.length,
      0
    );
  }
);

test(
  'service interpretation without server supplied services never invokes model',
  async () => {
    const h =
      loadUnderstanding();

    const result =
      await h.module
        .understandVoiceTurn({
          stage:
            'service',

          speech:
            'Facial',

          services: [],
        });

    assert.equal(
      result.kind,
      'unclear'
    );

    assert.equal(
      h.requests.length,
      0
    );
  }
);

test(
  'semantic request exposes no tools and disables storage',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name:
            'Facial',
          date_expression:
            'tomorrow',
          time_expression:
            'two thirty PM',
          confirmation: null,
          correction: false,
        },
      });

    await h.module
      .understandVoiceTurn({
        stage:
          'service',

        speech:
          'Facial tomorrow at two thirty PM',

        services:
          SERVICES,
      });

    assert.equal(
      h.requests.length,
      1
    );

    const request =
      h.requests[0];

    assert.equal(
      request.store,
      false
    );

    assert.equal(
      request.tools,
      undefined
    );

    assert.equal(
      request.model,
      'gpt-5.6-terra'
    );

    assert.equal(
      request.text.format.type,
      'json_schema'
    );

    assert.equal(
      request.text.format.strict,
      true
    );
  }
);

test(
  'semantic model receives service names but no application identifiers',
  async () => {
    const h =
      loadUnderstanding({
        response: {
          meaningful: true,
          service_name:
            'Facial',
          date_expression: null,
          time_expression: null,
          confirmation: null,
          correction: false,
        },
      });

    await h.module
      .understandVoiceTurn({
        stage:
          'service',

        speech:
          'I want a facial.',

        services:
          SERVICES,
      });

    const request =
      h.requests[0];

    const input =
      JSON.parse(
        request.input
      );

    assert.deepEqual(
      Array.from(
        input.allowed_services
      ),
      SERVICES
    );

    assert.equal(
      input.stage,
      'service'
    );

    assert.equal(
      input.caller_utterance,
      'I want a facial.'
    );

    assert.equal(
      'business_id' in input,
      false
    );

    assert.equal(
      'customer_id' in input,
      false
    );

    assert.equal(
      'appointment_id' in input,
      false
    );

    assert.equal(
      'phone' in input,
      false
    );

    assert.equal(
      'call_sid' in input,
      false
    );
  }
);