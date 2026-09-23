const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const read = path => fs.readFileSync(path, 'utf8');

test('marketing examples cannot invoke production call or appointment APIs', () => {
  const sources = ['app/page.tsx', 'components/marketing/CallDemo.tsx', 'components/marketing/ProductDemo.tsx'].map(read).join('\n');
  assert.doesNotMatch(sources, /fetch\s*\(|supabase|\/api\/voice|\/api\/appointments/);
  assert.match(sources, /Fictional call/);
  assert.match(sources, /No real call or booking is made/);
  assert.match(sources, /not a customer recording/);
});

test('call example offers pause, explicit steps and respects reduced motion', () => {
  const source = read('components/marketing/CallDemo.tsx');
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /Pause example/);
  assert.match(source, /setPlaying\(false\)/);
  assert.match(source, /if \(!playing \|\| reduced\) return/);
  assert.match(source, /clearInterval/);
  assert.match(source, /!document.hidden/);
});

test('call history is explicitly unavailable without fabricated rows or live metrics', () => {
  const source = read('app/calls/page.tsx');
  assert.match(source, /Coming soon/);
  assert.match(source, /No call activity is shown here/);
  assert.doesNotMatch(source, /supabase|fetch\s*\(|calls answered|conversion rate/i);
});

test('native modal provides inert background, cancellation, scroll cleanup and focus restoration', () => {
  const source = read('components/ui/dialog-surface.tsx');
  assert.match(source, /showModal\(\)/);
  assert.match(source, /onCancel=/);
  assert.match(source, /preventDefault\(\)/);
  assert.match(source, /previous\?\.focus\(\)/);
  assert.match(source, /document\.body\.style\.overflow = overflow/);
  for (const page of ['customers', 'services', 'knowledge']) {
    const source = read(`app/${page}/page.tsx`);
    assert.match(source, /<DialogSurface\s+aria-labelledby=/);
    assert.match(source, /if \(!saving\) closeEditor\(\)/);
  }
});

test('confirmation cancels pending actions on business switch/unmount and blocks duplicate dialogs', () => {
  const source = read('components/ui/use-confirmation.tsx');
  assert.match(source, /pending\.current\?\.\(false\)/);
  assert.match(source, /if \(pending\.current\) return Promise\.resolve\(false\)/);
  assert.match(source, /autoFocus/);
  for (const page of ['appointments', 'knowledge']) {
    const source = read(`app/${page}/page.tsx`);
    assert.doesNotMatch(source, /window\.confirm/);
    assert.match(source, /await confirm\(/);
    assert.match(source, /if \(!confirmed\)\s*\{\s*return;/);
  }
});

test('password auth is retained with accessible labels and native autofill', () => {
  const login = read('app/login/page.tsx'), signup = read('app/signup/page.tsx');
  assert.match(login, /supabase\.auth\.signInWithPassword/);
  assert.match(signup, /supabase\.auth\.signUp/);
  assert.match(login, /autoComplete="current-password"/);
  assert.match(signup, /autoComplete="new-password"/);
  for (const source of [login, signup]) {
    assert.match(source, /Show password/);
    assert.match(source, /htmlFor=/);
    assert.match(source, /autoComplete="email"/);
    assert.doesNotMatch(source, /signInWithOtp|verifyOtp|\balert\(/);
  }
});

test('appointment composer retains fields when collapsed and reveals on calendar create', () => {
  const source = read('app/appointments/page.tsx');
  assert.match(source, /<details className="booking-composer">/);
  assert.match(source, /if \(composer\) composer\.open = true/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test('month adapts to panel width and analytics exposes exact daily counts without hover', () => {
  const calendar = read('components/appointments/AppointmentCalendar.tsx');
  const analytics = read('app/analytics/page.tsx');
  assert.match(calendar, /calendar-day-count/);
  assert.match(calendar, /<SelectedDateAgenda/);
  assert.match(analytics, /View daily appointment counts/);
  assert.match(analytics, /dailyCounts\.map\(item =>/);
  assert.doesNotMatch(analytics, /min-w-\[720px\]/);
});
