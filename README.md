# Voice agent

The app transcribes Twilio calls using Deepgram Flux (`flux-general-en`) over
`wss://api.deepgram.com/v2/listen`. It sends Twilio's native mono, 8 kHz mu-law
audio in 80 ms frames and uses Flux's `EndOfTurn` to trigger a reply. Earlier
transcript updates still feed the existing interruption and call-screening flow.

Short answers such as "yes", "yeah", "yep", "yup", "uh-huh", and "mm-hmm"
can confirm the current question. A completed answer clears the previous audio
and its interruption timer before generating a reply. Questions become active
when their audio starts, and each Flux turn retains the question that was active
when the caller began speaking. This keeps a quick or repeated "yes" from being
applied to a question that had not started yet.

An incomplete enquiry answer such as "times" prompts for "yes, no, or sometimes".
Complete frequency answers such as "two times" and "twice a week" are retained.
Unclear speech is not automatically treated as consent or a website duration.

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

## Callback scheduling

Weekday names are included in the recognition hints. When a callback-day answer
is transcribed as "Rider", the agent asks whether the caller meant Friday and
waits for confirmation. Rejecting that suggestion asks for another day.

All callback time questions offer 9am to 5pm in the business's local time.
Out-of-hours answers, such as 10pm, and vague time windows require a specific
replacement time before the callback is confirmed. Spoken hours, AM/PM and
24-hour clock times are supported; a bare hour such as "three" in response to
the time question is read back as 3pm within the offered window.
