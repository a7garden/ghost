# Local voice client

`VoicePanel` connects microphone PCM to the selected local STT, submits the
transcript through its owner's existing durable action callback, and asks local
TTS to read only the committed assistant reply of a completed task. It does not
create a second agent conversation or maintain a server voice session.

`useVoiceCall` owns one controller in the conversation screen. `VoicePanel` is
presentational, so switching between a wide card and a narrow inline card does
not replace the active capture/playback controller. Hook integration props:

- `profileId`, `conversationId`, `profileName`: current conversation identity.
- `enabled`: actual host connection and profile permission. Configuration is
  checked again before microphone acquisition.
- `runningTasks`: live durable work count, independently maintained by the owner.
- `submitTranscript(text)`: existing submit/steer action with durable receipts.
  Do not bind its lifetime to the microphone's abort signal.
- `cancelWork()`: explicit cancellation of current durable work. Ending a call
  never invokes it.
- `latestReply: {id, taskId, text}`: a newly completed assistant response. Choose
  a stable message ID and its actual originating task. Do not send partial,
  cancelled, failed, or historical responses.
- `onSpeakingChange(boolean)`: starts only after WebAudio source playback begins
  and resets on completion, interruption, and teardown.

The default transport uses the existing bootstrap CSRF and the same-origin
`/ghost-api/voice/{config,transcribe,synthesize}` JSON endpoints. Speech audio
is a 16 kHz mono PCM16 WAV, bounded to 120 seconds / 4 MiB before dispatch. The two-minute capacity limit
reports an error without submitting a partial sentence.
Only the backend chooses a provider; there is no Web Speech API cloud fallback.
TTS requests carry a task ID, not renderer-provided text. Provider credentials
never enter this module.

The bundled Silero VAD v6.0 ONNX model runs through ONNX Runtime Web WASM
on one CPU thread. Model and runtime assets are served from Ghost's own origin;
no CDN or external speech service receives audio. Model loading and integrity
checks complete before microphone acquisition. Classification failure is shown
explicitly rather than falling back to treating loud environmental noise as speech.

Speech begins after 96 ms of sufficient speech probability. An utterance ends
after 1400 ms of non-speech, or 2400 ms without confident speech. Capture keeps
224 ms of preroll and 192 ms after the last speech frame. A short internal pause
remains in the same utterance; there is no fixed 20-second automatic submission.
Speech onset interrupts playback and pending synthesis. Muted/ended partial
segments do not submit. Microphone echo cancellation and noise suppression are
requested. WebKit's bounded ScriptProcessor capture emits silence to its output
and does not monitor microphone audio. Native microphone permission and
WKWebView capture permission remain host concerns.

Session generations protect late configuration and microphone acquisition;
utterance generations discard stale transcription; output generations abort
pending TTS fetches and discard late decoding/playback. This deliberately does
not abort durable submissions. Synthetic tests exercise those lifetimes and
local-only transport contracts. They do not prove real microphone recognition,
acoustic echo cancellation, speaker output, or macOS permission dialogs.

Actual-model tests use generated Qwen Korean speech and deterministic clicks,
hiss and typing. They are separate from human microphone, chewing-noise,
WebKit/WASM, acoustic echo and physical speaker validation.
