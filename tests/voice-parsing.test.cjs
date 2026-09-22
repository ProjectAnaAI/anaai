const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const twilio = require('twilio');
function load(file, imports = {}, env = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, process: { env }, require: name => {
    if (name === 'server-only') return {};
    assert.ok(name in imports); return imports[name];
  }});
  return exports;
}
const p = load('lib/voice-parsing.ts', { './ai-actions': load('lib/ai-actions.ts') });
for (const [input, value] of [
  ['1 PM','13:00'], ['1 p.m.','13:00'], ['one PM','13:00'], ['one p m','13:00'],
  ['1:00 PM','13:00'], ["one o'clock PM",'13:00'], ['at one PM','13:00'], ['around one PM','13:00'],
  ['2:30 PM','14:30'], ['two thirty PM','14:30'], ['half past two PM','14:30'],
  ['noon','12:00'], ['12 noon','12:00'], ['midday','12:00'], ['midnight','00:00'],
  ['12 AM','00:00'], ['12 PM','12:00'], ['00:00','00:00'], ['09:00','09:00'], ['13:00','13:00'], ['23:59','23:59'],
  ['three in the afternoon','15:00'], ['three thirty in the afternoon','15:30'],
  ['ten in the morning','10:00'], ['seven in the evening','19:00'], ['  ONE   P.M.! ','13:00'],
  ['two oh five pm','14:05'], ['two forty five pm','14:45'],
]) test(`time: ${input}`, () => {
  const result = p.parseSpokenTime(input); assert.equal(result.kind, 'valid'); assert.equal(result.value, value);
});
for (const input of ['one', "one o'clock", 'at one', 'two thirty', 'half past two', '3:00']) test(`ambiguous time: ${input}`, () => {
  const result = p.parseSpokenTime(input); assert.equal(result.kind, 'ambiguous'); assert.equal(result.options.length, 2);
});
for (const input of ['', '25 PM', '13 PM', '24:00', '23:60', '0 PM', 'one sixty PM', '1 PM or 3 PM', 'random 1 PM', '999:00', 'quarter to twelve PM']) test(`invalid time: ${input}`, () => assert.equal(p.parseSpokenTime(input).kind, 'invalid'));
const now = Date.parse('2026-09-16T02:00:00Z'); // Tuesday locally, Wednesday UTC.
for (const [input, expected] of [
  ['2026-09-24','2026-09-24'], ['today','2026-09-15'], ['tomorrow','2026-09-16'],
  ['September 24','2026-09-24'], ['September 24th','2026-09-24'], ['September 24 2026','2026-09-24'],
  ['2026 September 24th','2026-09-24'], ['September twenty fourth','2026-09-24'],
  ['the 24th of September','2026-09-24'], ['this Friday','2026-09-18'], ['next Friday','2026-09-25'],
  ['February 30',null], ['2026 February 29',null], ['September 24 or 25',null], ['0000-01-01',null],
  ['January 1','2027-01-01'], ['2025 September 24','2025-09-24'],
]) test(`date: ${input}`, () => assert.equal(p.bookingDate(input, 'America/Los_Angeles', now), expected));
test('relative dates fail closed without timezone and DST uses calendar days', () => {
  assert.equal(p.bookingDate('today', null, now), null);
  assert.equal(p.businessLocalDate('America/Los_Angeles', 1, Date.parse('2026-03-08T07:30:00Z')), '2026-03-08');
  assert.equal(p.businessLocalDate('invalid-zone', 0, now), null);
});
const services = [{ name: 'Haircut' }, { name: 'Facial' }];
for (const input of ['Haircut','HAIRCUT','hair cut','hair-cut',"I'd like a haircut",'can I get a haircut','the haircut','a haircut please','haircuts']) test(`service: ${input}`, () => assert.equal(p.matchVoiceService(services,input).match?.name, 'Haircut'));
for (const input of ['I want facial','a facial please']) test(`service: ${input}`, () => assert.equal(p.matchVoiceService(services,input).match?.name, 'Facial'));
test('service ambiguity and unknown/empty input never select', () => {
  const result = p.matchVoiceService([{name:'Haircut basic'},{name:'Haircut premium'}], 'a haircut please');
  assert.equal(result.match,null); assert.equal(result.candidates.length,2);
  assert.equal(p.matchVoiceService([{name:'Haircut'},{name:'Hair cut'}], 'hair-cut').match,null);
  for (const input of ['', 'unknown']) assert.equal(p.matchVoiceService(services,input).match,null);
});
for (const input of ['yes','yeah','yep','correct',"that's correct",'sounds good','book it','confirm','please book it']) test(`affirmative: ${input}`, () => assert.equal(p.confirmation(input),'yes'));
for (const input of ['no','nope','cancel',"don't book it", "that's wrong", 'start over']) test(`negative: ${input}`, () => assert.equal(p.confirmation(input),'no'));
for (const input of ['', 'maybe', 'okay', 'yes but change the time', 'yes no', 'not correct']) test(`unclear confirmation: ${input}`, () => assert.equal(p.confirmation(input),'ambiguous'));
test('Gather settings are bounded, stage-specific and contain only supplied hints', () => {
  const c = load('lib/voice-config.ts');
  assert.equal(c.gatherOptions('confirm').speechTimeout,'2');
  assert.equal(c.gatherOptions('time').speechTimeout,'2');
  assert.equal(c.gatherOptions().speechModel,'experimental_conversations');
  assert.equal(c.gatherOptions('confirm').speechModel,'experimental_conversations');
  assert.equal(c.gatherOptions('service').speechModel,'experimental_conversations');
  // Unsafe entries are dropped; safe service names lead, then shared
  // scheduling vocabulary so any detail can be spoken at any booking turn.
  const hinted = c.gatherOptions('service',['Haircut','bad,entry','<invalid>']).hints.split(',');
  assert.equal(hinted[0],'Haircut');
  assert.ok(!hinted.some(h => /bad|entry|invalid/.test(h)));
  assert.ok(hinted.includes('tomorrow') && hinted.includes('PM'));
  assert.ok(!c.gatherOptions('confirm').hints.split(',').some(h => /[<>,]/.test(h)));
  assert.ok(c.gatherOptions('confirm').hints.split(',').includes('yes'));
  // Deduplicated and bounded.
  assert.equal(c.gatherOptions('service',Array(400).fill('Haircut')).hints.split(',').filter(h => h === 'Haircut').length,1);
  assert.ok(c.gatherOptions('service',Array.from({length:400},(_, i) => `Service ${i}`)).hints.split(',').length <= 100);
  // Non-booking turns still send no hints.
  assert.equal(c.gatherOptions().hints,undefined);
});
for (const [configured, expected] of [[undefined,'Polly.Joanna-Neural'],['Polly.Joanna-Neural','Polly.Joanna-Neural'],['alice','alice'],['unsupported','alice']]) test(`TTS configuration ${configured}`, () => {
  const c=load('lib/voice-config.ts',{}, {TWILIO_TTS_VOICE:configured});
  const response = new twilio.twiml.VoiceResponse(); response.say(c.voiceOptions(),'Hello.');
  assert.match(response.toString(),new RegExp(`voice="${expected}"`));
});
test('yearless leap day retains next-year fallback', () => {
  assert.equal(p.bookingDate('February 29','America/Los_Angeles',Date.parse('2027-09-16T12:00:00Z')),'2028-02-29');
});

for (const input of [
  'I would like a facial, please.', "I'd like a facial, please", 'I would like facial',
  'Can I get a facial please', 'Facial please', 'The facial', 'I want the facial',
  'Could I book a facial', "I'd like to book a facial",
]) test(`production facial phrase: ${input}`, () => {
  const routed = [{ name: 'facial' }, { name: 'haircut' }, { name: 'waxing' }];
  assert.equal(p.matchVoiceService(routed, input).match?.name, 'facial');
  assert.equal(p.confirmation(input), 'ambiguous');
});

test('conversational booking wrappers preserve authority and ambiguity', () => {
  for (const input of ['Could I book a facial', "I'd like to book a facial"]) {
    assert.equal(p.matchVoiceService([{ name: 'haircut' }], input).match, null);
    const ambiguous = p.matchVoiceService([{ name: 'facial basic' }, { name: 'facial premium' }], input);
    assert.equal(ambiguous.match, null);
    assert.equal(ambiguous.candidates.length, 2);
  }
  for (const input of ['facial or waxing', 'do not book a facial', 'invent a facial', 'facial and haircut']) {
    assert.equal(p.matchVoiceService([{ name: 'facial' }, { name: 'waxing' }], input).match, null);
  }
  const literal = { name: 'Could I book a facial' };
  assert.equal(p.matchVoiceService([literal, { name: 'facial' }], literal.name).match, literal);
});

test('production afternoon phrase parses as explicit PM time', () => {
  const result = p.parseSpokenTime('2:30 in the afternoon');
  assert.equal(result.kind, 'valid');
  assert.equal(result.value, '14:30');
});

test('speech-recognition omission of the article in afternoon phrase remains explicit PM', () => {
  for (const speech of [
    '2:30 in afternoon',
    'two thirty in afternoon',
  ]) {
    const result = p.parseSpokenTime(speech);
    assert.equal(result.kind, 'valid');
    assert.equal(result.value, '14:30');
  }
});

test('period-of-day article omission is controlled and bare time remains ambiguous', () => {
  const morning = p.parseSpokenTime('three in morning');
  assert.equal(morning.kind, 'valid');
  assert.equal(morning.value, '03:00');

  const evening = p.parseSpokenTime('three in evening');
  assert.equal(evening.kind, 'valid');
  assert.equal(evening.value, '15:00');

  const bare = p.parseSpokenTime('two thirty');
  assert.equal(bare.kind, 'ambiguous');
});
