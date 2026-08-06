# AIRI Voice Input Demo

Standalone browser diagnostic for AIRI's recorder-backed voice pipeline. It runs without Electron or the main AIRI application and exposes every step from microphone capture to MiMo transcription.

## Run

From the repository root:

```powershell
pnpm -F @proj-airi/voice-input-demo dev
```

Open `http://127.0.0.1:4178`, enter a MiMo API key, and click **开始监听**. Browser microphone access requires localhost or HTTPS; this demo deliberately uses localhost and does not use `mkcert`.

## What it verifies

- 16 kHz mono microphone capture through the shared AIRI AudioWorklet
- Silero VAD probability and segmentation
- Local rejection of segments with less than 300 ms classified speech or less than 15% speech ratio
- WAV generation and in-page playback of accepted segments
- Sequential MiMo `mimo-v2.5-asr` requests while the next segment continues recording
- Provider text/error display per segment

The API key remains in Vue component memory. The demo does not write it to local storage, files, or AIRI settings.
