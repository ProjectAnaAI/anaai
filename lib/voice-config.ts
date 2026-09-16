import "server-only";
import type VoiceResponse from "twilio/lib/twiml/VoiceResponse";

// Official Twilio <Say> en-US voices. Keep an explicit fallback/rollback option.
const VOICES = ['Polly.Joanna-Neural', 'Polly.Joanna', 'alice'] as const;
export function voiceOptions(): VoiceResponse.SayAttributes {
  const configured = process.env.TWILIO_TTS_VOICE?.trim();
  const voice = VOICES.find(value => value === configured) || (configured ? 'alice' : 'Polly.Joanna-Neural');
  return { voice, language: 'en-US' };
}
export function gatherOptions(stage?: string, services: string[] = []): VoiceResponse.GatherAttributes {
  const hints = stage === 'service'
    ? services.filter(name => name.length <= 80 && !/[<>\x00-\x1f,]/.test(name)).slice(0, 30).join(',')
    : stage === 'confirm' ? 'yes,no,correct,book it,cancel'
    : stage === 'time' ? 'AM,PM,noon,midnight' : '';
  return {
    input: ['speech', 'dtmf'], numDigits: 1, method: 'POST', timeout: 6,
    // Generic model retains Twilio provider failover. Do not use deprecated enhanced.
    speechModel: stage ? 'experimental_utterances' : 'experimental_conversations', speechTimeout: stage === 'confirm' ? '1' : '2',
    language: 'en-US', actionOnEmptyResult: true,
    ...(hints ? { hints } : {}),
  };
}
