# my-knowledge-hub

An iMessage tutor. An erudite, Socratic AI tutor that converses with a learner over iMessage — seeded with topics from `knowledge.md` and powered by an OpenRouter LLM. Built on [Spectrum](https://photon.codes/docs/spectrum-ts), so the same agent loop can be wired to other platforms (terminal, WhatsApp Business) by adding providers.

## Environment

Copy the template and fill in your own values:

```sh
cp .env.example .env
```

| Var | Required | Purpose |
|---|---|---|
| `PROJECT_ID`, `PROJECT_SECRET` | yes | Spectrum credentials from your [Photon dashboard](https://app.photon.codes) |
| `OPENROUTER_API_KEY` | yes | OpenRouter key ([get one](https://openrouter.ai/keys)) — powers the tutor |
| `OPENROUTER_MODEL` | no | Any OpenRouter model id. Default `openai/gpt-4o-mini` |
| `DOC_PATH` | no | Markdown file of seed topics. Default `./knowledge.md` |
| `LEARNER_PHONE` | no | Number to send the daily morning prompt to. Leave blank to disable |
| `MORNING_CRON` | no | 5-field cron for the morning prompt. Default `0 8 * * *` |
| `MORNING_TZ` | no | Timezone for the cron. Default `Australia/Sydney` |

`.env` is gitignored — never commit it. `.env.example` is the public template (placeholders only).

## Topics

`knowledge.md` holds the learner's seed topics as a numbered list. Edit it freely — at runtime, texting `reload` re-reads it without restarting the app. Once the seeds are exhausted, texting `next` asks the LLM for fresh topics in the same spirit.

## Run

```sh
npm install
npm run start     # tsx src/index.ts
npm run dev       # tsx watch src/index.ts (auto-restart on changes)
npm run typecheck # tsc --noEmit
```

## Conversation commands

Text the tutor from the `LEARNER_PHONE` number (or any number Spectrum bridges):

- **A number** — pick topic N from the list.
- **Free text** — start a brand-new topic on the spot.
- **`next`** / **`fresh`** — generate fresh topics in the same spirit.
- **`back`** / **`list`** / **`topics`** / **`start`** / **`help`** — show the topic list again.
- **`reset`** — return to your original seed topics.
- **`reload`** — re-read `DOC_PATH` so edits take effect live.
- Anything else — a conversational turn on the current topic.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Edit `knowledge.md` to change the seed topics, or `src/persona.ts` to change the tutor's voice.
- Add more providers (terminal TUI, WhatsApp Business) from `spectrum-ts/providers/*` in `src/index.ts`.