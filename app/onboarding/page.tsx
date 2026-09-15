'use client';

import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { newOnboardingDraft, onboardingDays, isOnboardingDraft, validateOnboarding } from '@/lib/onboarding';

const steps = ['Business', 'Hours', 'Services', 'Receptionist', 'Review'];
const inputStyle = 'w-full rounded-lg border px-3 py-2';
export default function OnboardingPage() {
  const [draft, setDraft] = useState(newOnboardingDraft);
  const [storageKey, setStorageKey] = useState('');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (cancelled) return;
      if (!user) { setError('Please log in again to continue setup.'); return; }
      const key = `anaai:onboarding:${user.id}`;
      try {
        const saved = sessionStorage.getItem(key);
        if (saved) {
          const parsed = JSON.parse(saved);
          // Incomplete drafts are expected; validate shape before rendering.
          if (isOnboardingDraft(parsed)) {
            setDraft({ ...newOnboardingDraft(), ...parsed });
          }
        }
      } catch { /* Storage can be unavailable; setup remains usable. */ }
      setStorageKey(key);
    }).catch(() => { if (!cancelled) setError('Unable to restore your session. Please reload or log in again.'); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (storageKey) {
      try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Keep the in-memory draft. */ }
    }
  }, [draft, storageKey]);
  function field(key: 'name' | 'phone' | 'email' | 'address' | 'receptionist' | 'greeting', label: string, type = 'text') {
    return <label className="block space-y-1">{label}<input className={inputStyle} type={type} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>;
  }
  async function finish() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    try {
      try { validateOnboarding(draft); } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Check your setup details.');
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token || storageKey !== `anaai:onboarding:${session.user.id}`) { setError('Please log in again to finish setup.'); return; }
      const response = await fetch('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(draft) });
      const result = await response.json();
      if ((response.ok && result.success === true) || (response.status === 409 && result.code === 'ALREADY_PROVISIONED')) {
        try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
        // Reload membership discovery after the committed transaction, including a lost-response retry.
        window.location.assign('/dashboard');
        return;
      }
      throw Error('Unable to finish setup. Check your details and try again.');
    } catch {
      setError('Unable to finish setup. Check your details and try again.');
    } finally { submitting.current = false; setBusy(false); }
  }
  if (!storageKey) return <main className="p-8">{error ? <><p role="alert">{error}</p><a href="/login">Log in</a></> : "Loading setup..."}</main>;
  return <main className="min-h-screen bg-slate-50 p-6"><div className="mx-auto max-w-2xl rounded-xl border bg-white p-6 space-y-6">
    <div><h1 className="text-2xl font-semibold">Set up your business</h1><p className="text-sm text-slate-500">Step {step + 1} of 5 · {steps[step]}</p></div>
    <fieldset disabled={busy} className="space-y-4">
      {step === 0 && <>{field('name', 'Business name *')}{field('phone', 'Phone (optional)', 'tel')}{field('email', 'Email (optional)', 'email')}{field('address', 'Address (optional)')}<p className="text-sm text-slate-500">Timezone: America/Los_Angeles</p></>}
      {step === 1 && onboardingDays.map(day => <div key={day} className="flex flex-wrap items-center gap-3"><span className="w-24 capitalize">{day}</span><label><input type="checkbox" checked={draft.hours[day].closed} onChange={e => setDraft({ ...draft, hours: { ...draft.hours, [day]: { ...draft.hours[day], closed: e.target.checked } } })} /> Closed</label>{!draft.hours[day].closed && <>{(['open', 'close'] as const).map(key => <label key={key}>{key}<input className={inputStyle} type="time" value={draft.hours[day][key]} onChange={e => setDraft({ ...draft, hours: { ...draft.hours, [day]: { ...draft.hours[day], [key]: e.target.value } } })} /></label>)}</>}</div>)}
      {step === 2 && <>{draft.services.map((service, i) => <div key={i} className="rounded-lg border p-4 space-y-3">{(['name', 'duration', 'price', 'description'] as const).map(key => <label className="block" key={key}>{({ name: 'Service name *', duration: 'Duration in minutes *', price: 'Price (optional)', description: 'Description (optional)' })[key]}<input className={inputStyle} value={service[key]} type={key === 'duration' || key === 'price' ? 'number' : 'text'} min={key === 'duration' ? 1 : 0} step={key === 'price' ? '0.01' : '1'} onChange={e => setDraft({ ...draft, services: draft.services.map((s, j) => j === i ? { ...s, [key]: e.target.value } : s) })} /></label>)}{draft.services.length > 1 && <button type="button" onClick={() => setDraft({ ...draft, services: draft.services.filter((_, j) => j !== i) })}>Remove service</button>}</div>)}<button type="button" disabled={draft.services.length >= 50} onClick={() => setDraft({ ...draft, services: [...draft.services, { name: '', duration: '30', price: '', description: '' }] })}>+ Add service</button></>}
      {step === 3 && <>{field('receptionist', 'Receptionist name *')}{field('greeting', 'Greeting *')}</>}
      {step === 4 && <div className="space-y-2"><p className="font-medium">{draft.name || 'Business name required'}</p><p>{draft.services.length} service(s) · America/Los_Angeles</p><ul>{draft.services.map((s, i) => <li key={i}>{s.name || 'Service name required'} · {s.duration} minutes{s.price && ` · $${s.price}`}</li>)}</ul><p>Receptionist: {draft.receptionist}</p><p>{draft.greeting}</p><p className="text-sm text-slate-500">Your business is created only when you finish setup. Use Back to review your hours and details.</p></div>}
    </fieldset>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <div className="flex justify-between"><button disabled={busy || step === 0} onClick={() => { setStep(step - 1); setError(''); }}>Back</button>{step < 4 ? <button className="rounded-lg bg-emerald-600 px-4 py-2 text-white" onClick={() => setStep(step + 1)}>Next</button> : <button disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50" onClick={() => void finish()}>{busy ? 'Finishing setup...' : 'Finish onboarding'}</button>}</div>
  </div></main>;
}
