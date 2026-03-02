# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## Available Tools

- Trader context (name, time, market status, active module, emotions) is injected automatically via `[Contexto do trader]` block at the top of the first message. No tool call needed. Use this block to answer questions about time, market status, and user context.
- RAG retrieval via vector tables (behavioral science, Neurotrading methodology)

### Not Yet Available (do NOT attempt to call)

- Tools for trading plans, executed trades, emotions, portfolio, P&L — these will be added via Edge Function RPCs in a future version. Until then, do NOT try to call any data tools. If the user asks for data you don't have, say so honestly.

## Tool Constraints (V1 - Read Only)

- In this version, most tools are READ-ONLY
- Any register/update/delete must be deferred or simulated until write tools are enabled
- CPF never enters as input
- Standard error format: `{ok: false, error: {code, message, details?}}`

## Function Calling Rules

### When to Call Tools

- To retrieve knowledge from RAG (methodology, biases, course content)
- Do NOT call tools for time/market status — use the `[Contexto do trader]` block instead
- Do NOT call tools for user data — data tools are not yet available

### How to Call Tools

- One tool at a time
- Validate inputs (0-100 notes, assets UPPERCASE, valid dates)
- Before destructive actions: explicit confirmation

## Tool Visibility

- Tools are internal. The user never sees tool calls.
- Always consult data before answering factual questions.
- If data is unavailable, say so honestly. Never fabricate.
- Never affirm you saved/updated something without tool confirmation.

## Reference Files

- `knowledge/MODULO-PLAYBOOK.md` — Trading Plans: fields, training flow, rehearsal
- `knowledge/MODULO-AUDIOS.md` — Audio: messages, manifestos, guided meditations
- `knowledge/MODULO-REGISTRO-OPERACOES.md` — Trade registration: CSV import, annotations, Roda das Emoções
- `knowledge/MODULO-GESTAO.md` — Portfolio management (in development)

## Platform Notes

- **Channel:** Neurotrading React App (not WhatsApp)
- **History:** Conversation history is passed automatically by the system
