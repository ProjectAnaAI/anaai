const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { RestException } = require('twilio');
const sid = 'SM' + 'a'.repeat(32);
const privateText = 'PRIVATE_PHONE_BODY_CREDENTIALS';
function load(file, imports, logs = []) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, Error, AbortSignal, require: name => {
      if (name === 'server-only') return {};
      assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name];
    },
    process: { env: { TWILIO_ACCOUNT_SID: privateText, TWILIO_AUTH_TOKEN: privateText, TWILIO_PHONE_NUMBER: privateText } },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });
  return exports;
}
function providerError(status, code = 572006) {
  return new RestException({ statusCode: status, body: { code, message: privateText, more_info: privateText, details: { secret: privateText } } });
}
function harness({ error, response = { sid }, events = [] } = {}) {
  const logs = [];
  const sdk = () => ({ messages: { create: async () => { events.push('send'); if (error !== undefined) throw error; return response; } } });
  sdk.RestException = RestException;
  const api = load('lib/twilio.ts', { twilio: { default: sdk } }, logs);
  return { ...api, logs, events, run: () => api.sendSms({ to: privateText, body: privateText }) };
}
test('successful message creation with SID is accepted without sensitive logs', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(result.success, true); assert.equal(result.messageSid, sid);
  assert.ok(!JSON.stringify(h.logs).includes(sid)); assert.ok(!JSON.stringify(h.logs).includes(privateText));
});
for (const status of [400, 401, 403, 404, 422, 429]) test(`Twilio HTTP ${status} rejection is failed, not uncertain`, async () => {
  const h = harness({ error: providerError(status) }); const result = await h.run();
  assert.equal(result.success, false); assert.equal(result.outcome, 'failed');
  assert.deepEqual(JSON.parse(JSON.stringify(h.logs)), [['AnaAI SMS provider request failed.', { code: 572006, status }]]);
  assert.ok(!JSON.stringify(result).includes(privateText)); assert.equal(h.events.length, 1);
});
for (const error of [providerError(408), providerError(500), providerError(503), Object.assign(new Error(privateText), { code: 'ETIMEDOUT' }), Object.assign(new Error(privateText), { code: 'ECONNRESET' }), Object.assign(new Error(privateText), { status: 400 }), privateText, { message: privateText, status: 400 }]) test('transport, timeout, 5xx or unverified error remains uncertain', async () => {
  const h = harness({ error }); const result = await h.run();
  assert.equal(result.success, false); assert.equal(result.outcome, 'uncertain');
  assert.ok(!JSON.stringify(h.logs).includes(privateText)); assert.ok(!JSON.stringify(result).includes(privateText)); assert.equal(h.events.length, 1);
});
for (const response of [null, {}, { sid: '' }, { sid: privateText }]) test('malformed acceptance receipt is uncertain, never successful', async () => {
  const h = harness({ response }); const result = await h.run();
  assert.equal(result.success, false); assert.equal(result.outcome, 'uncertain'); assert.ok(!JSON.stringify(h.logs).includes(privateText));
});
test('diagnostic fields reject nonnumeric sensitive values', async () => {
  const h = harness({ error: providerError(privateText, privateText) });
  assert.equal((await h.run()).outcome, 'uncertain');
  assert.deepEqual(JSON.parse(JSON.stringify(h.logs)), [['AnaAI SMS provider request failed.', { code: null, status: null }]]);
});
for (const [error, expected] of [[undefined, 'accepted'], [providerError(400), 'failed'], [new Error(privateText), 'uncertain']]) test(`real SMS adapter integrates with voice notification ${expected}; booking stays successful`, async () => {
  const events = [], h = harness({ error, events });
  const id = n => `${n}`.repeat(8) + '-' + `${n}`.repeat(4) + '-4' + `${n}`.repeat(3) + '-8' + `${n}`.repeat(3) + '-' + `${n}`.repeat(12);
  const business = id(1), service = id(2); let recorded, claimed = false;
  const receipt = { success: true, changed: true, replayed: false, action_id: id(3), action_type: 'book', receipt_scope: 'action_outcome', appointment_id: id(4), customer_id: id(5), business_id: business, service_id: service, service: 'Haircut', date: '2099-09-20', time: '10:00:00', status: 'Booked' };
  const db = {
    from: () => {
      const q = {}; for (const method of ['select', 'eq', 'order', 'limit', 'abortSignal']) q[method] = () => q;
      q.then = resolve => Promise.resolve({ data: [{ id: service, name: 'Haircut' }] }).then(resolve); return q;
    },
    rpc: async (name, params) => {
      if (name === 'voice_book_appointment_business') { events.push('commit'); return { data: receipt }; }
      if (name === 'voice_claim_appointment_notification') {
        assert.ok(events.includes('commit')); if (claimed) return { data: { claimed: false } }; claimed = true;
        return { data: { claimed: true, id: id(6), token: id(7), kind: 'confirmation', payload: { phone: privateText, date: receipt.date, time: receipt.time } } };
      }
      assert.equal(name, 'voice_finish_appointment_notification'); recorded = params; return { data: true };
    },
  };
  const ai = load('lib/ai-actions.ts', {});
  const voice = load('lib/voice-booking.ts', {
    '@/lib/voice-parsing': load('lib/voice-parsing.ts', { './ai-actions': load('lib/ai-actions.ts', {}) }),
    'node:crypto': require('node:crypto'), '@/lib/ai-actions': ai,
    '@/lib/appointment-actions': { isUuid: v => typeof v === 'string' && /^[\da-f-]{36}$/i.test(v) },
    '@/lib/supabase-server': { createSupabaseServiceClient: () => db }, '@/lib/twilio': h,
  }, h.logs);
  const request = { businessId: business, idempotencyKey: id(8), customerName: 'Test', customerPhone: '+12025550123', serviceId: service, serviceName: 'Haircut', date: receipt.date, time: '10:00' };
  const result = await voice.executeVoiceBooking(request);
  assert.equal(result.success, true); assert.equal(result.smsSent, expected === 'accepted');
  assert.equal(recorded.p_status, expected); assert.deepEqual(events, ['commit', 'send']);
  assert.equal(recorded.p_provider_id, expected === 'accepted' ? sid : null);
  receipt.replayed = true;
  assert.equal((await voice.executeVoiceBooking(request)).success, true);
  assert.equal(events.filter(e => e === 'send').length, 1);
  assert.ok(!JSON.stringify(h.logs).includes(privateText));
});
