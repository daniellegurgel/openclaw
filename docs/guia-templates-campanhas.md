# Guia prático: Templates para campanhas — Neurotrading

Autora: Danielle Gurgel
Data: 2026-02-25

## O problema

Você quer mandar uma mensagem para um lead que nunca falou com você (ou que não fala há mais de 24 horas). A Meta **não deixa** mandar texto livre. Se tentar, dá erro 131047 e a mensagem não chega.

A Meta exige que a primeira mensagem seja um **template aprovado**. Isso é uma regra anti-spam da plataforma.

## O que é um template

Template é uma mensagem com **estrutura fixa** e **espaços para preencher**.

Exemplo de template chamado `aviso_aula_v1`:

```
Oi {{1}}, amanhã às {{2}} teremos a aula sobre {{3}}. {{4}}
```

- `{{1}}` = nome da pessoa (ex: "Paulo")
- `{{2}}` = horário (ex: "19h")
- `{{3}}` = tema (ex: "análise técnica")
- `{{4}}` = chamada (ex: "Te espero lá!")

Resultado entregue ao lead: *"Oi Paulo, amanhã às 19h teremos a aula sobre análise técnica. Te espero lá!"*

A estrutura é sempre a mesma. O que muda são os valores nas lacunas.

## Onde criar os templates

1. Acesse o **Gerenciador de Negócios do Facebook**: https://business.facebook.com
2. Vá em **WhatsApp > Gerenciamento de conta > Modelos de mensagens**
3. Clique em **Criar modelo**
4. Escolha a categoria:
   - **Marketing** — campanhas, convites para lives, prospecção
   - **Utilidade** — confirmações, lembretes, avisos operacionais
5. Escreva o texto com as variáveis `{{1}}`, `{{2}}`, etc.
6. Envie para aprovação (leva de algumas horas a 2 dias)

**Link direto do app CHAT da Neurotrading:**
https://developers.facebook.com/apps/3943674439224651/whatsapp-business/wa-dev-console/

## Exemplos de templates que você vai precisar

### 1. Prospecção (lead frio — primeiro contato)
**Nome:** `prospeccao_fellipe_v1`
**Categoria:** Marketing
**Texto:**
```
Oi {{1}}, tudo bem? Aqui é o Fellipe da Neurotrading. {{2}}
```
- `{{1}}` = nome do lead
- `{{2}}` = motivo do contato (ex: "Vi que você se interessou pelo nosso curso de trading.")

### 2. Aviso de aula/live
**Nome:** `aviso_aula_v1`
**Categoria:** Marketing
**Texto:**
```
Oi {{1}}, {{2}} às {{3}} teremos {{4}}. {{5}}
```
- `{{1}}` = nome
- `{{2}}` = "amanhã" ou "hoje"
- `{{3}}` = horário
- `{{4}}` = descrição da aula
- `{{5}}` = chamada ("Te espero lá!", "Não perca!")

### 3. Follow-up (lead não respondeu)
**Nome:** `followup_fellipe_v1`
**Categoria:** Marketing
**Texto:**
```
Oi {{1}}, mandei uma mensagem antes mas talvez você não tenha visto. {{2}}
```
- `{{1}}` = nome
- `{{2}}` = contexto ("Ainda tenho vagas para o Intensive de março.")

## O fluxo completo — passo a passo

### Cenário: campanha de prospecção com o Fellipe

```
PASSO 1 — Você (Dani)
  Cria o template no painel da Meta
  Ex: "prospeccao_fellipe_v1"
  Aguarda aprovação (algumas horas)

PASSO 2 — Você (Dani)
  Cria o workflow no n8n que dispara a campanha
  O workflow pega a lista de leads e, para cada um, manda:

    POST /hooks/agent
    {
      "message": "Você está iniciando uma campanha de prospecção para
                  o lead Paulo Silva, que demonstrou interesse no curso
                  Intensive. Seja cordial e profissional.",
      "to": "+5511999999999",
      "channel": "api-meta",
      "deliver": true,
      "sessionKey": "campanha-intensive:+5511999999999",
      "channelData": {
        "api-meta": {
          "template": {
            "name": "prospeccao_fellipe_v1",
            "language": "pt_BR",
            "variables": ["Paulo", "Vi que você se interessou pelo Intensive."]
          }
        }
      }
    }

PASSO 3 — O sistema (automático)
  O agente (Fellipe) recebe a mensagem e cria uma SESSÃO
  com o contexto da campanha ("lead Paulo, curso Intensive...").
  O template é enviado pela API Meta → lead recebe no WhatsApp.

PASSO 4 — O lead responde
  "Oi, sim, tenho interesse!"
  A resposta chega pelo webhook da Meta → o agente já tem a sessão
  com todo o contexto → responde com inteligência, sabendo que
  o Paulo é lead do Intensive.

PASSO 5 — Conversa livre
  Agora que o lead respondeu, a janela de 24h está aberta.
  O agente pode mandar texto livre, sem template.
  A conversa flui normalmente.
```

### Cenário: aviso de live (disparo em massa, sem conversa)

```
PASSO 1 — Você (Dani)
  Template "aviso_aula_v1" já aprovado

PASSO 2 — Workflow no n8n
  Para cada aluno, manda direto (sem agente):

    POST /hooks/api-meta/template
    {
      "to": "+5511999999999",
      "template": {
        "name": "aviso_aula_v1",
        "language": "pt_BR",
        "variables": ["Paulo", "amanhã", "19h", "aula de análise técnica", "Te espero lá!"]
      }
    }

  Aqui não precisa do agente porque é só um aviso.
  Se o aluno responder, o atendimento normal do WhatsApp (2223) pega.
```

## Os dois caminhos — quando usar cada um

| Situação | Caminho | Endpoint | Agente cria sessão? |
|----------|---------|----------|---------------------|
| Prospecção (quer conversar depois) | Pelo agente | POST /hooks/agent | Sim — o Fellipe sabe o contexto |
| Aviso de aula / disparo simples | Direto | POST /hooks/api-meta/template | Não — só manda e pronto |
| Follow-up de campanha | Pelo agente | POST /hooks/agent | Sim — continua a sessão |

## Regras importantes da Meta

1. **Primeira mensagem para lead frio = template obrigatório** (não tem como escapar)
2. **Depois que o lead responde**, janela de 24h abre — texto livre liberado
3. **Cada variação de estrutura** = template separado (precisa aprovar)
4. **Variáveis são para dados dinâmicos** (nome, data, horário), não para reescrever a mensagem inteira
5. **Não exagere nas variáveis** — template muito genérico é reprovado pelo Meta
6. **Limite prático**: até ~1000 templates por número, mas 5-10 bem feitos cobrem tudo
7. **Aprovação leva horas** — crie os templates com antecedência, não no dia da campanha

## Como o código monta e envia o template (dentro do OpenClaw)

Dois arquivos trabalham juntos. Você **não precisa editar nenhum deles** para usar templates novos — o código é genérico.

### Arquivo 1: `extensions/neurotrading-api-meta/index.ts` — o canal

Este é o "carteiro" do WhatsApp. Quando o n8n manda um POST com `channelData`, o código faz isto:

```
JSON chega do n8n
       ↓
extrairTemplate()              ← linha 256
  Abre o channelData e procura: channelData["api-meta"]["template"]
  Se encontrou → pega name, language e variables
  Se faltou name ou language → avisa no log e ignora
  Se variables veio vazio → avisa no log (a Meta pode rejeitar)
       ↓
sendPayload()                  ← linha 405
  Recebeu o template extraído?
    SIM → chama enviarTemplateCloudApi (arquivo 2)
           depois espelha no Chatwoot: "[Template: prospeccao_fellipe_v1 | vars: Paulo, Vi que...]"
    NÃO → manda como texto ou mídia normal
```

**Resumo:** este arquivo **decide** o que enviar. Se veio template, envia template. Se não, envia texto.

### Arquivo 2: `src/integrations/neurotrading-meta-cloud-api.ts` — a API

Este é o "telefone" — faz a ligação com a Meta. A função `enviarTemplateCloudApi` (linha 604) monta o JSON que a Meta espera:

```
Recebe:  { name: "prospeccao_fellipe_v1", language: "pt_BR", variables: ["Paulo", "Vi que..."] }
         ↓
Monta o JSON da Meta:
{
  "messaging_product": "whatsapp",
  "to": "5511999999999",
  "type": "template",
  "template": {
    "name": "prospeccao_fellipe_v1",
    "language": { "code": "pt_BR" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Paulo" },
          { "type": "text", "text": "Vi que..." }
        ]
      }
    ]
  }
}
         ↓
Envia via POST para: https://graph.facebook.com/v21.0/{phoneNumberId}/messages
         ↓
Meta preenche o template e entrega no WhatsApp do lead
```

Repare: `variables: ["Paulo", "Vi que..."]` virou `parameters` com `type: "text"`. O `{{1}}` recebe "Paulo", o `{{2}}` recebe "Vi que...". **A ordem importa** — a primeira variável preenche `{{1}}`, a segunda `{{2}}`, e assim por diante.

### Quando editar esses arquivos?

| Situação | Precisa editar? |
|----------|-----------------|
| Criar template novo (ex: `convite_live_v1`) | **NÃO** — cria na Meta, usa no n8n |
| Adicionar imagem no header do template | **NÃO** — já suporta `headerImageUrl` |
| Mudar o comportamento do envio (ex: novo tipo de mensagem) | **SIM** — edita `index.ts` |
| A Meta muda a API dela (nova versão do Graph) | **SIM** — edita `meta-cloud-api.ts` |

## Resumo rápido

- **Template** = mensagem com lacunas, aprovada pela Meta
- **Quem cria** = você, no painel do Facebook
- **Quem preenche as lacunas** = o n8n (no workflow), passando as `variables` no JSON
- **Quem decide como enviar** = `index.ts` (a extensão/canal)
- **Quem monta o JSON e envia pra Meta** = `meta-cloud-api.ts` (a integração)
- **Quem recebe** = o lead, no WhatsApp dele
- **Quem responde** = o agente Fellipe (se for campanha) ou atendimento humano (se for aviso)
- **Template novo = zero código** — só Meta + n8n
