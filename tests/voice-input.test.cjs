const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, imports = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Buffer, process: { env: { VOICE_STATE_SECRET: 'ab'.repeat(32) } },
    require: name => name === 'server-only' ? {} : imports[name] || require(name) });
  return exports;
}
const input = load('lib/voice-input.ts');
const state = load('lib/voice-state.ts');
const binding = { businessId: '11111111-1111-4111-8111-111111111111', callSid: 'CA' + 'a'.repeat(32), ingress: 'production' };

for (const [raw, expected] of [
  [null, 'missing'], [undefined, 'missing'], ['', 'missing'], ['  ', 'missing'],
  ['0', 'low'], ['0.349', 'low'], ['0.35', 'medium'], ['.69', 'medium'], ['0.7', 'high'], ['1', 'high'],
  ['NaN', 'invalid'], ['Infinity', 'invalid'], ['-1', 'invalid'], ['1.01', 'invalid'],
  ['not-a-number', 'invalid'], ['0x1', 'invalid'], ['1e-1', 'invalid'], [0.95, 'invalid'],
]) test(`confidence ${JSON.stringify(raw)} -> ${expected}`, () => assert.equal(input.voiceConfidence(raw), expected));

for (const speech of ['BJ', 'Jo', 'yes', 'no', 'PM', 'AM', '李', '3']) {
  test(`missing confidence preserves short speech: ${speech}`, () => assert.equal(input.classifyVoiceInput(speech, '', 'missing').kind, 'speech'));
}
for (const confidence of ['missing', 'low', 'invalid', 'high']) {
  test(`empty precedes confidence: ${confidence}`, () => assert.equal(input.classifyVoiceInput(' \n\t ', '', confidence).kind, 'empty'));
  test(`DTMF independent of confidence: ${confidence}`, () => assert.equal(input.classifyVoiceInput('', '1', confidence).kind, 'dtmf'));
}
for (const speech of ['...', '@@@', '—!?', 'um', 'uh', 'hmm', 'um, uh']) {
  test(`unusable speech: ${speech}`, () => assert.equal(input.classifyVoiceInput(speech, '', 'high').kind, 'rejected'));
}
for (const [speech, digits] of [['yes', '1'], ['...', '1'], ['', '11'], ['', '#'], ['', '*'], ['', 'a']]) {
  test(`mixed/invalid ${JSON.stringify([speech, digits])}`, () => assert.equal(input.classifyVoiceInput(speech, digits, 'high').kind, 'invalid'));
}
test('alternating unsuccessful input shares a bound; accepted progress resets it', () => {
  const s = { silence: 0 };
  assert.equal(input.recoverVoiceInput(s, true), false);
  assert.equal(input.recoverVoiceInput(s), false);
  assert.equal(s.silence, 0);
  assert.equal(input.recoverVoiceInput(s, true), true);
  input.acceptVoiceProgress(s);
  assert.equal(s.recovery, 0);
  assert.equal(s.silence, 0);
  assert.equal(input.recoverVoiceInput(s, true), false);
  assert.equal(input.recoverVoiceInput(s, true), true);
});
test('stateless recovery URLs preserve the same counters', () => {
  let s = input.statelessVoiceRecovery('listen');
  input.recoverVoiceInput(s, true);
  assert.equal(input.voiceRecoveryMode(s), 'retry');
  s = input.statelessVoiceRecovery(input.voiceRecoveryMode(s));
  input.recoverVoiceInput(s);
  s = input.statelessVoiceRecovery(input.voiceRecoveryMode(s));
  assert.equal(input.recoverVoiceInput(s, true), true);
});
for (const flow of ['menu', 'booking', 'management']) {
  test(`${flow}: legacy/current recovery state validates and remains bound to the call`, () => {
    const s = flow === 'booking' ? state.initialBookingState() : flow === 'management'
      ? state.initialManagementState(state.initialVoiceState(), 'cancel') : state.initialVoiceState();
    for (const recovery of [undefined, 0, 1, 2]) {
      if (recovery === undefined) delete s.recovery; else s.recovery = recovery;
      const token = state.sealVoiceState(s, binding);
      assert.equal(state.openVoiceState(token, binding).recovery, recovery);
      assert.throws(() => state.openVoiceState(token, { ...binding, callSid: 'CA' + 'b'.repeat(32) }));
    }
    for (const recovery of [-1, 3, 1.5, '1', null]) {
      s.recovery = recovery;
      assert.throws(() => state.openVoiceState(state.sealVoiceState(s, binding), binding));
    }
  });
}
test('diagnostic correlation is stable, scoped and does not expose its input', () => {
  const id = state.voiceDiagnosticId(binding);
  assert.match(id, /^[a-f0-9]{24}$/);
  assert.equal(id, state.voiceDiagnosticId(binding));
  assert.notEqual(id, state.voiceDiagnosticId({ ...binding, ingress: 'trial' }));
  assert.notEqual(state.voiceDiagnosticId(binding, 'token1'), state.voiceDiagnosticId(binding, 'token2'));
});
