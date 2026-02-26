AGENTS.md

## Projeto: OpenClaw (Neurotrading)

- Desenvolvedora: Danielle Gurgel (chamar de Dani)
- Documentação e comentários no código: sempre em português
- Atribuição nos comentários: Danielle Gurgel

## Credenciais e Infra

Arquivo de credenciais: `c:\dev\credentials.md` — contém todos os acessos:
- Server: 212.85.0.144 (SSH key: ~/.ssh/openclaw-server)
- Chatwoot: chat.neurotrading.com.br (localhost:3000 no server)
- EspoCRM: crm.neurotrading.com.br (nginx + PHP-FPM + MariaDB, /var/www/espocrm/)
- Supabase, n8n, Mautic, Google OAuth — tudo no credentials.md

## Stack no servidor 212.85.0.144

- OpenClaw Gateway: porta 18789 (localhost, nginx proxy em ai.neurotrading.com.br)
- Chatwoot: porta 3000 (localhost, nginx proxy em chat.neurotrading.com.br)
- EspoCRM: nginx + PHP-FPM (crm.neurotrading.com.br)
- n8n: porta 5678
- MariaDB (EspoCRM), PostgreSQL (Chatwoot)
- File Browser: porta 8080

## Arquitetura de Automação (CRM + AI)

```
MAUTIC (marketing) → n8n (automação) → ESPOCRM (vendas) ↔ OPENCLAW (robô WhatsApp)
```

### Ciclo de vida do lead
1. Visitante preenche formulário no site → Mautic captura
2. Mautic webhook → n8n (Workflow 1) → cria/atualiza Lead no EspoCRM (status "Novo")
3. Humano cria Task no Lead (EspoCRM) → webhook → n8n (Workflow 3) → OpenClaw envia WhatsApp
4. OpenClaw conversa com lead via IA → resultado → n8n (Workflow 4) → atualiza Lead no EspoCRM
5. Lead qualificado → Converter Lead → Contact + Opportunity → pipeline de vendas

### Status do Lead (EspoCRM)
Novo → Contatado → Qualificado → Converted (ou Não qualificado)

### Stages da Opportunity
Proposta (30%) → Negociação (60%) → Ganhou (100%) / Perdido (0%)

### Workflows n8n ativos

| # | Nome | ID | Webhook | Função |
|---|------|----|---------|--------|
| 1 | Mautic - Sincronizar lead com CRM | 06ad3da1a28f47c981f4e | POST /webhook/mautic-to-crm | Mautic form → cria/atualiza Lead no EspoCRM |
| 3 | Iniciar chat de prospecção | 3a79a37d9b944d2782b26 | POST /webhook/crm-task-to-openclaw | Task no Lead → OpenClaw envia WhatsApp |
| 4 | OpenClaw - Atualizar lead no CRM | 2e02e07e8a7a4dda9fdfb | POST /webhook/openclaw-result-to-crm | Resultado da conversa → atualiza Lead |
| - | Buscar aluno por telefone | rvLjDugeWZ7UkKND | GET /webhook/buscar-aluno | Consulta dados de aluno |

### Webhooks configurados

**Mautic → n8n:** webhook ID 2, evento `mautic.form_on_submit` → http://212.85.0.144:5678/webhook/mautic-to-crm
**EspoCRM → n8n:** webhook ID 6993e6574e2037b8b, evento `Task.create` → http://localhost:5678/webhook/crm-task-to-openclaw
**n8n → OpenClaw:** POST http://127.0.0.1:18789/hooks/agent (Bearer hooks-token)

### OpenClaw — dois modos de disparo

| Modo | Comando CLI | Uso |
|------|-------------|-----|
| Direto | `openclaw message send --target {phone} --message "{msg}"` | Texto fixo, sem IA (avisos, lembretes) |
| Agente IA | `openclaw agent --to {phone} --message "{msg}" --deliver --json` | IA personaliza e conversa |

### Scripts no servidor

| Script | Função |
|--------|--------|
| `/root/scripts/openclaw-ws-watchdog.sh` | Watchdog: reinicia gateway se WhatsApp congelar |
| `/root/scripts/check-exec.py {wf_id}` | Verificar última execução de workflow |

### EspoCRM — cron obrigatório

```
* * * * * cd /var/www/espocrm && sudo -u www-data php cron.php > /dev/null 2>&1
```
Sem esse cron, webhooks do EspoCRM nunca disparam.

### Entidades customizadas no EspoCRM
- **Task.cCanal** — campo enum (WhatsApp/Email/Telefone), define canal de comunicação do robô
- **CSessao** — registro de sessão de conversa (entidade customizada)

## Memos de Contexto

Quando trocar de contexto e voltar, leia estes arquivos para recuperar estado:
- `MEMO-PROSPECCAO-OUTBOUND.md` — Sistema de prospecção outbound (template Meta, agente Fellipe, pipeline de delivery). Contém pegadinhas, estado atual e próximos passos.

## REGRAS IMPORTANTES

### PROIBIDO desviar do plano acordado
- NUNCA mudar a arquitetura ou o plano sem autorização explícita da Dani.
- Se a Dani analisou um problema, desenhou uma solução e aprovou um plano, EXECUTE EXATAMENTE o que foi acordado.
- NÃO criar atalhos, bypasses ou "gambiarras" que mudem quem faz o quê na arquitetura.
- Se durante a implementação surgir uma dúvida ou alternativa, PARE e pergunte antes de desviar.
- Incidente 2026-02-25: Dani pediu que o AGENTE montasse o template (composição inteligente das variáveis). Em vez disso, fiz o n8n montar o template pronto e o agente virou fantoche (texto descartado). Isso violou o plano aprovado e desperdiçou tempo. NÃO repetir.

### Diretórios — NUNCA jogar arquivos temporários no diretório do projeto (c:\dev\openclaw)
- Scripts temporários (tmp_*) → rodar e apagar, ou salvar em `C:\Users\SAMSUNG\Documents\ALUNOS\` se for relatório
- CSVs de exportação/relatório → `C:\Users\SAMSUNG\Documents\ALUNOS\`
- O diretório `c:\dev\openclaw` é SÓ para código do projeto OpenClaw