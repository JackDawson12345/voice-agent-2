# Voice agent

The app transcribes Twilio calls using Deepgram Flux (`flux-general-en`) over
`wss://api.deepgram.com/v2/listen`. It sends Twilio's native mono, 8 kHz mu-law
audio in 80 ms frames and uses Flux's `EndOfTurn` to trigger a reply. Earlier
transcript updates still feed the existing interruption and call-screening flow.

## Deepgram configuration

Keep your existing `DEEPGRAM_API_KEY` in the environment or `.env`. No new
dependency or audio conversion is required.

Optional settings:

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `DEEPGRAM_EOT_THRESHOLD` | `0.7` | Confidence needed to end a turn, from `0.5` to `1.0`. Higher values wait for more confidence. |
| `DEEPGRAM_EOT_TIMEOUT_MS` | `5000` | Maximum silence after speech before ending the turn, from `500` to `60000` milliseconds. This is a fallback; confident turns finish sooner. |
| `DEEPGRAM_KEYTERMS` | Empty | Comma-separated recognition hints, added to the call's business/location hints and the built-in survey terms. |

`DEEPGRAM_ENDPOINTING_MS` and `DEEPGRAM_UTTERANCE_END_MS` were Nova settings and
are no longer used. Remove them from your deployment configuration and use the
Flux settings above if tuning is needed. Eager response generation is disabled;
the app waits for a confirmed `EndOfTurn` before processing a survey answer.

See Deepgram's [Flux migration guide](https://developers.deepgram.com/docs/flux/nova-3-migration)
and [API reference](https://developers.deepgram.com/reference/speech-to-text/listen-flux).

Run `npm test` for the local regression suite and restart the app with `npm start`
after deploying the changes. A live transcription check requires a valid
Deepgram API key and incoming Twilio audio.
