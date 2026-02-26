# MEMO: Sistema de Prospecção Outbound — Estado Atual

> Danielle Gurgel, 2026-02-25
> Atualizado por Claude para preservar contexto entre sessões.

## Visão Geral do Fluxo

```
EspoCRM (Task "Iniciar Prospecção")
  → n8n workflow "Iniciar chat de prospecção" (id: 3a79a37d9b944d2782b26)
    → POST /hooks/agent no OpenClaw Gateway
      → Agente Fellipe acorda (workspace-fellipe)
        → Lê knowledge/CAMPANHA-FUNIL.md
        → Gera [[template: prospeccao_fellipe_v2 | saudação | nome]]
          → parseTemplateDirective extrai → channelData["api-meta"].template
            → deliverOutboundPayloads → sendPayload → enviarTemplateCloudApi → Meta
              → Lead recebe template no WhatsApp
```

## O Que Já Funciona (testado 2026-02-25)

1. **Campo `agent` no hook** — Adicionado suporte para `agent` no POST /hooks/agent.
   Sem isso, todos os dispatches caíam no agente `dani` (default) ao invés do `fellipe`.
   - Arquivos modificados: `src/gateway/hooks.ts`, `src/gateway/server/hooks.ts`, `src/gateway/server-http.ts`
   - O n8n manda `"agent": "fellipe"` no body

2. **Agente Fellipe gera template corretamente** — Sessões `66c75c25` e `9a6547ad` confirmam:
   - Agente recebe `[CRM - Abordagem]` com `tipo: Funil`
   - Usa tool `read` para carregar `knowledge/CAMPANHA-FUNIL.md`
   - Gera: `[[template: prospeccao_fellipe_v2 | Bom dia | Paulo]]`

3. **parseTemplateDirective funciona** — Transforma a string em:
   ```json
   {
     "channelData": {
       "api-meta": {
         "template": {
           "name": "prospeccao_fellipe_v2",
           "language": "pt_BR",
           "variables": ["Bom dia", "Paulo"]
         }
       }
     }
   }
   ```

4. **Pipeline de delivery** (deliver.ts linha 330):
   - Checa `handler.sendPayload && payload.channelData` → chama `sendPayload`
   - Extension api-meta TEM `sendPayload` (index.ts linha 405)
   - `sendPayload` → `enviarTemplateCloudApi` → Meta Cloud API

## O Que Está Bloqueado

### Template `prospeccao_fellipe_v2` — STATUS: PENDING na Meta
- ID: 1433792828294280
- WABA ID: 580559168467176
- Categoria: MARKETING (requer aprovação manual da Meta, pode levar até 24h+)
- Body: "Olá, {{1}}! {{2}} Aqui é o Fellipe, do Neurotrading..."
- {{1}} = saudação (Bom dia/Boa tarde/Boa noite)
- {{2}} = primeiro nome do lead

**Enquanto PENDING, qualquer envio retorna erro 132015.**

### Templates disponíveis:
| Template | Status | Variáveis |
|----------|--------|-----------|
| `prospeccao_fellipe_v2` | PENDING | {{1}} saudação, {{2}} nome |
| `abertura_fellipe` | PENDING | {{1}} nome |
| `prospeccao_fellipe` (v1) | **APPROVED** | {{1}} nome (só 1 variável) |
| `hello_world` | APPROVED | nenhuma customizável |

**Alternativa**: usar `prospeccao_fellipe` (v1) que já está aprovado, mas precisa atualizar `CAMPANHA-FUNIL.md` pra instruir o agente a usar v1 com apenas 1 variável.

## PEGADINHAS / GOTCHAS

### 1. Campo `agent` no hook é OBRIGATÓRIO para fellipe
Sem `"agent": "fellipe"` no POST body, o dispatch usa o agente default (`dani`),
que tem workspace diferente (`workspace-dani`) sem a pasta `knowledge/`.
O agente não encontra CAMPANHA-FUNIL.md e gera resposta genérica.

### 2. Workspaces são isolados por agente
- `/root/.openclaw/workspace-fellipe/knowledge/CAMPANHA-FUNIL.md` ← correto
- `/root/.openclaw/workspace-dani/knowledge/` ← NÃO EXISTE
- Cada agente só vê seu próprio workspace

### 3. knowledge/ NÃO é auto-carregado
Apenas bootstrap files são injetados automaticamente (SOUL.md, AGENTS.md, TOOLS.md, etc.).
Arquivos em `knowledge/` precisam ser lidos via tool `read` pelo agente.
O AGENTS.md do Fellipe instrui ele a buscar na pasta knowledge/ quando recebe `[CRM - Abordagem]`.

### 4. parseTemplateDirective zera o texto
Quando o agente gera APENAS `[[template:...]]` (sem texto adicional), o payload fica com
`text: undefined` e só `channelData`. Isso é correto — `isRenderablePayload` aceita
payloads com apenas `channelData`. Mas se algo filtrar payloads sem texto, quebraria.

### 5. Template de marketing precisa aprovação da Meta
Templates `UTILITY` são aprovados automaticamente. Templates `MARKETING` passam por revisão
humana da Meta. Pode levar horas ou dias. Não há como acelerar.

### 6. Logs do gateway
- Arquivo: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Serviço: `systemctl --user restart openclaw-gateway` (user service, NÃO system)
- Sessions: `/root/.openclaw/agents/fellipe/sessions/`
- Para verificar template: API Meta `GET /v21.0/{WABA_ID}/message_templates?name={nome}`

### 7. Delivery não logou nos testes de 13:05
Os testes via curl às 13:05/13:06 provavelmente não incluíram `"deliver": true` no payload,
por isso o agente rodou mas não tentou entregar. Quando o template for aprovado,
testar com deliver: true no payload do hook.

### 8. n8n workflow "Iniciar chat de prospecção"
- ID: 3a79a37d9b944d2782b26
- Payload que manda para OpenClaw inclui: message, to, channel ("api-meta"), deliver (true), sessionKey, agent ("fellipe")
- O channelData NÃO vem do n8n — o agente é quem decide o template

## Arquivos-Chave Modificados Nesta Sessão

| Arquivo | O que mudou |
|---------|-------------|
| `src/gateway/hooks.ts` | Adicionado `agent?: string` ao HookAgentPayload e normalizeAgentPayload |
| `src/gateway/server/hooks.ts` | Adicionado `agent` ao dispatchAgentHook, passa `agentId` ao runCronIsolatedAgentTurn |
| `src/gateway/server-http.ts` | Adicionado `agent` ao tipo HookDispatchers |

## Próximos Passos (quando template for aprovado)

1. Verificar status: `curl -s -H "Authorization: Bearer {TOKEN}" "https://graph.facebook.com/v21.0/580559168467176/message_templates?name=prospeccao_fellipe_v2"`
2. Disparar teste via EspoCRM Task → n8n → OpenClaw (com deliver: true)
3. Verificar no log: delivery + resposta da Meta
4. Verificar Chatwoot: espelhamento do template
5. Verificar se lead recebe no WhatsApp
6. Quando lead responde → agente Fellipe já tem sessão com contexto → responde naturalmente

## Comando Rápido para Checar Template

```bash
curl -s -H "Authorization: Bearer EAA4CwEIPTUsBQxcb1zh2ee4y0GwKSN3ghDVsdnfNZBHMuy9ljt4vlDnO7em38IVum32hSMKFa5z4ErX3ubbaUT6EVtxaEZANJ7UKqDKzJI7doejx5XKFmqcz41FV83ZBpP1to43jiiCH7YEGqaXCFwrEOgZAl6AIBMo6JQzKN6fSN6RymvvRnCUTxySIVXw6xgZDZD" \
  "https://graph.facebook.com/v21.0/580559168467176/message_templates?name=prospeccao_fellipe_v2"
```
