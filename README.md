# Pocket TTS Webapp

React + TypeScript web client for the Pocket TTS API.

The API server is not bundled here. Run it separately, then set its base URL in the app's Settings tab.

## App features

- Script workspace with direct WAV generation
- Voiceover plan builder that splits a script into editable beats
- Per-beat rendering and download
- Voice library view with default and custom voices
- Custom voice upload through the API
- Base URL settings with health and endpoint checks

## Verified API surface

The app was built against the public repo at https://github.com/umairzahid604/pocket-tts-api and uses these verified endpoints:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Returns API info like `{ "message": "Voice Generation API", "status": "running" }` |
| GET | `/health` | Returns `{ "status": "healthy" }` |
| GET | `/getvoiceslist` | Returns `{ voices, default, total }` |
| POST | `/generate` | Accepts JSON `{ text, voice? }` and returns a WAV file |
| POST | `/uploadvoice` | Accepts `multipart/form-data` with `file` and optional `name` |

## `/generate` behavior

- Request body: JSON with `text` and optional `voice`
- Response: binary WAV file
- Response headers used by the app:
  - `Content-Disposition`
  - `X-Word-Count`
  - `X-Chunks-Count`
  - `X-Voice-Used`
- Common failures:
  - `400` when text is missing
  - `400` when a voice is not found
  - `500` for generation errors

## `/uploadvoice` behavior

- Content type: `multipart/form-data`
- Supported file fields in the server: `file`, `audio`, `voiceFile`
- This app sends `file`
- Optional naming fields on the server: `name`, `voice_name`, `voiceName`
- This app sends `name`
- Success response example:

```json
{
  "detail": "Voice uploaded successfully",
  "voice": "myvoice",
  "filename": "myvoice.wav",
  "total": 12
}
```

## Run

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

## Notes

- The server enables CORS with `app.use(cors())`, so the app can call it directly from the browser.
- The app stores the API base URL in local storage.
- The voiceover plan builder is client-side. It groups script text into short beats for easier render/download flow.
