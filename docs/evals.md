# Scenario evals

`npm run eval` runs 13 scenarios through the real pipeline against real Tarka models. Messages go to the models; Google and the chat channels are faked. The scenarios: sign-up, local time, reminders (absolute and relative), lists, calendar, email with approval, an injected instruction in an email, a repeating task, the morning brief, a quiet check-in, and an unverified caller.

```bash
npm run eval                                         # every model in ALLOWED_MODELS
npm run eval -- --models deepseek-v4.1-flash-eu      # one model
npm run eval -- --only reminder                      # one scenario
```

Needs `TARKA_API_KEY` in `.env`. Each scenario runs twice per model by default.

## Results, 16 October 2026

| Model | Passed | Average time per scenario | Cost of the run |
|---|---:|---:|---:|
| deepseek-v4.1-flash | 24/24 | 2.5 s | $0.032 |
| glm-5.3-flash | 24/24 | 4.5 s | $0.025 |
| kimi-k3 | 21/24 | 6.4 s | $0.31 |
| qwen3.8-flash-next (retired 23 Oct 2026) | 23/24 | 37.4 s | $0 |

Notes from the runs:

- **Kimi K3:** results varied between runs; another run the same day passed 24/24. It often ends with an empty reply or a lost tool call. `src/agent/turn.ts` asks again (twice at most, and text-only once something has changed), which recovers most of them. The misses were an empty reply after two retries, a reply that was raw JSON, and a greeting the check didn't recognise. It is left out of the default model picker until the router's fixes land.
- **Qwen:** its one miss was a check-in that hit the 150-second limit; it generated about 28 tokens a second in these runs and has since been retired from Tarka's catalogue.
- **Before the fixes found by the first run,** the same scenarios passed 18, 20, 19 and 13 times out of 24. The first run turned up a calendar bug ("tomorrow" was read as 9 AM to 9 AM), Kimi's empty and garbled replies, and models asking "shall I send it?" before calling a tool that already asks.

## Memory

The memory engine was chosen in a separate bake-off on 25 October 2026 (102 LongMemEval-S questions, DeepSeek V4.1 Flash answering for every system): Hindsight scored 87.3%, against 83.3% for putting the whole conversation history in the prompt, 79.4% for plain search over the history, and 58.8% for Mnemosyne. Hindsight was strongest on questions about when things happened (76%) and facts that changed (94%), and weaker on facts spread across several sessions (65%).
