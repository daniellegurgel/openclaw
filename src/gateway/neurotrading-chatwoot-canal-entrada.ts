/**
 * =============================================================================
 * HANDLER HTTP — Canal de Entrada Chatwoot (AgentBot Webhook) para OpenClaw
 * =============================================================================
 *
 * Autora: Danielle Gurgel — Neurotrading
 * Criado em: 2026-03-11
 * Revisado em: 2026-03-11 — correções pós-revisão externa:
 *   1. Mutex por conversationId (serialização de mensagens por conversa)
 *   2. Check de handoff (não responder se humano assumiu a conversa)
 *   3. Filtro anti-loop AND em vez de OR (mais rigoroso)
 *   4. Hash determinístico no fallback de messageId (dedup mais confiável)
 *
 * -----------------------------------------------------------------------------
 * CONTEXTO DE NEGÓCIO
 * -----------------------------------------------------------------------------
 * O Chatwoot serve como hub de atendimento da Neurotrading (chat.neurotrading.com.br).
 * Até agora, o OpenClaw espelhava mensagens do WhatsApp → Chatwoot (via ponte-chatwoot.ts),
 * mas a comunicação era UNIDIRECIONAL: visitantes do widget do site não tinham resposta.
 *
 * Este módulo implementa o CAMINHO INVERSO: quando um visitante envia uma mensagem
 * pelo widget do Chatwoot no site, o webhook do AgentBot é disparado para cá.
 * O handler recebe a mensagem, invoca o agente IA (Fellipe) via o mesmo pipeline
 * de agente isolado (runCronIsolatedAgentTurn), e envia a resposta de volta
 * ao Chatwoot via API REST (enviarMensagemChatwoot).
 *
 * Fluxo completo:
 *   1. Visitante digita no widget do site → Chatwoot recebe
 *   2. Chatwoot dispara AgentBot webhook → POST /hooks/chatwoot-inbound
 *   3. Este handler valida, deduplica, extrai dados
 *   4. Verifica se a conversa está em handoff (humano assumiu)
 *   5. Serializa por conversa (mutex — uma mensagem por vez por conversa)
 *   6. Invoca o agente Fellipe via runCronIsolatedAgentTurn (deliver=false)
 *   7. Captura o texto de resposta do agente
 *   8. Envia a resposta de volta ao Chatwoot via enviarMensagemChatwoot
 *
 * POR QUE não usar processMessage?
 *   processMessage é acoplado ao WhatsApp (chama espelharMensagemEntrada,
 *   sendMessageWhatsApp, etc). Precisaríamos hackear vários pontos pra redirecionar
 *   a resposta pro Chatwoot. Usar runCronIsolatedAgentTurn com deliver=false é
 *   mais limpo: o agente roda normalmente, capturamos o outputText, e enviamos
 *   manualmente pro Chatwoot. Zero acoplamento com WhatsApp.
 *
 * POR QUE deliver=false?
 *   O pipeline de delivery padrão só conhece canais registrados (whatsapp, telegram,
 *   etc). "chatwoot" não é um canal registrado. Ao desabilitar o deliver automático,
 *   pegamos o texto cru do agente e enviamos nós mesmos via API REST do Chatwoot.
 *
 * -----------------------------------------------------------------------------
 * DECISÕES TÉCNICAS
 * -----------------------------------------------------------------------------
 *   - Import dinâmico de runCronIsolatedAgentTurn (evita circular deps)
 *   - Resposta HTTP 200 imediata (fire-and-forget para processamento)
 *   - Deduplicação por message ID do Chatwoot (Map com TTL 10 min)
 *   - Filtro anti-loop com AND: exige message_type=incoming E sender.type=contact
 *   - Session key baseada no conversation ID: "chatwoot-conv-{id}"
 *   - Mutex por conversationId: garante ordem de processamento por conversa
 *   - Check de handoff antes de processar: se humano assumiu, bot fica quieto
 *   - Hash determinístico para fallback de messageId (dedup confiável)
 *   - Sem HMAC: o Chatwoot AgentBot webhook não envia assinatura — autenticação
 *     é feita pelo Bearer token do hooks (mesmo que os outros subpaths)
 *
 * =============================================================================
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { ChatwootConfig } from "../integrations/ponte-chatwoot.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("chatwoot-canal-entrada");

// =============================================================================
// Deduplicação por messageId — protege contra reprocessamento quando o Chatwoot
// reenvia um webhook (ex.: crash pós-200, timeout de rede).
// Map<messageId, timestampMs> com cleanup periódico (TTL 10 min).
// Padrão copiado de neurotrading-hooks-meta-whatsapp.ts.
// (Danielle Gurgel — Neurotrading, 2026-03-11)
// =============================================================================
const processedIds = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutos
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 1000; // cleanup a cada 1 min

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedIds) {
    if (now - ts > DEDUP_TTL_MS) {
      processedIds.delete(id);
    }
  }
}, DEDUP_CLEANUP_INTERVAL_MS).unref(); // unref() para não impedir shutdown do processo

// =============================================================================
// Mutex por conversationId — serialização de processamento por conversa
// (Danielle Gurgel — Neurotrading, 2026-03-11)
//
// PROBLEMA RESOLVIDO:
//   Se o visitante manda 3 mensagens rápido, sem mutex cada uma dispara
//   runCronIsolatedAgentTurn em paralelo na mesma sessão. Resultado:
//   contexto embaralhado, respostas fora de ordem, IA "alucinando".
//
// SOLUÇÃO:
//   Map<conversationId, Promise> que encadeia processamentos sequencialmente.
//   Cada nova mensagem espera a anterior terminar antes de começar.
//   Isso garante que o agente vê o histórico completo a cada turno.
//
// POR QUE Map e não Redis?
//   O OpenClaw roda como processo ÚNICO (não PM2 cluster, não replicado).
//   Em single-process Node, Map com encadeamento de Promises funciona
//   perfeitamente — cada mensagem espera a anterior no mesmo event loop.
// =============================================================================
const conversationLocks = new Map<number, Promise<void>>();

/**
 * Enfileira uma tarefa para ser executada sequencialmente por conversationId.
 * Se já há uma tarefa rodando para esta conversa, a nova espera ela terminar.
 * Se não há, executa imediatamente.
 *
 * Após a execução (sucesso ou erro), limpa o lock se não há mais tarefas atrás.
 *
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
function enfileirarPorConversa(conversationId: number, tarefa: () => Promise<void>): void {
  const lockAtual = conversationLocks.get(conversationId) ?? Promise.resolve();

  const novaProm = lockAtual
    .then(() => tarefa())
    .catch((err) => {
      log.error(`Erro na fila de conv=${conversationId}`, {
        error: err instanceof Error ? err.stack : String(err),
      });
    })
    .finally(() => {
      // Limpa o lock se esta é a última tarefa encadeada
      // (se outra tarefa foi adicionada depois, conversationLocks[id] !== novaProm)
      if (conversationLocks.get(conversationId) === novaProm) {
        conversationLocks.delete(conversationId);
      }
    });

  conversationLocks.set(conversationId, novaProm);
}

// =============================================================================
// Lazy-init para imports dinâmicos (evita import circular com agents/cron).
// Node faz cache de módulos, mas a Promise resolve instantaneamente após o
// primeiro import. (Danielle Gurgel — Neurotrading, 2026-03-11)
// =============================================================================
let _runCronIsolatedAgentTurn:
  | (typeof import("../cron/isolated-agent.js"))["runCronIsolatedAgentTurn"]
  | null = null;
let _enviarMensagemChatwoot:
  | (typeof import("../integrations/ponte-chatwoot.js"))["enviarMensagemChatwoot"]
  | null = null;
let _createDefaultDeps: (typeof import("../cli/deps.js"))["createDefaultDeps"] | null = null;

async function getRunCronIsolatedAgentTurn() {
  if (!_runCronIsolatedAgentTurn) {
    _runCronIsolatedAgentTurn = (await import("../cron/isolated-agent.js"))
      .runCronIsolatedAgentTurn;
  }
  return _runCronIsolatedAgentTurn;
}

async function getEnviarMensagemChatwoot() {
  if (!_enviarMensagemChatwoot) {
    _enviarMensagemChatwoot = (await import("../integrations/ponte-chatwoot.js"))
      .enviarMensagemChatwoot;
  }
  return _enviarMensagemChatwoot;
}

async function getCreateDefaultDeps() {
  if (!_createDefaultDeps) {
    _createDefaultDeps = (await import("../cli/deps.js")).createDefaultDeps;
  }
  return _createDefaultDeps;
}

// =============================================================================
// Tipos do payload do webhook AgentBot do Chatwoot
// Documentação: https://www.chatwoot.com/docs/product/others/agent-bots
// (Danielle Gurgel — Neurotrading, 2026-03-11)
// =============================================================================

/** Estrutura do payload do webhook AgentBot do Chatwoot. */
interface PayloadWebhookChatwoot {
  event?: string;
  /** Tipo da mensagem: "incoming" (visitante) ou "outgoing" (agente/bot) */
  message_type?: string;
  /** Texto da mensagem enviada pelo visitante */
  content?: string;
  /** ID numérico da mensagem no Chatwoot */
  id?: number;
  conversation?: {
    id?: number;
    contact_inbox?: { source_id?: string };
  };
  contact?: {
    id?: number;
    name?: string;
    phone_number?: string;
    email?: string | null;
  };
  inbox?: {
    id?: number;
    name?: string;
  };
  account?: {
    id?: number;
  };
  /** Quem enviou: "contact" = visitante, "user" = agente humano/bot */
  sender?: {
    id?: number;
    name?: string;
    type?: string;
  };
}

// =============================================================================
// Helpers
// =============================================================================

const BODY_READ_TIMEOUT_MS = 10_000; // 10s — proteção contra slowloris

/**
 * Lê o body cru da requisição como Buffer.
 * Inclui timeout para proteção contra conexões travadas (slowloris).
 * Padrão copiado de neurotrading-hooks-meta-whatsapp.ts.
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
function lerBodyCru(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log.warn("Timeout ao ler body do webhook Chatwoot (slowloris?)");
        req.destroy();
        resolve(null);
      }
    }, BODY_READ_TIMEOUT_MS);

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

/**
 * Obtém a config do Chatwoot a partir do config geral.
 * Retorna null se desabilitada ou incompleta.
 * Diferente de obterConfigChatwoot em ponte-chatwoot.ts, aqui NÃO exigimos inboxId
 * porque o canal de entrada aceita mensagens de qualquer inbox.
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
function obterConfigChatwootEntrada(cfg: {
  integrations?: { chatwoot?: ChatwootConfig };
}): ChatwootConfig | null {
  const cw = cfg.integrations?.chatwoot;
  if (!cw?.enabled || !cw.baseUrl || !cw.apiToken || !cw.accountId) {
    return null;
  }
  return cw;
}

/**
 * Gera um hash determinístico para messageId de fallback.
 * Quando o Chatwoot não envia payload.id (raro, mas possível), precisamos
 * de um ID estável para que retry do mesmo webhook não gere ID diferente.
 *
 * Combina conversationId + senderId + conteúdo (sem timestamp).
 * Isso garante que retry do MESMO webhook gera o MESMO hash, independente
 * de quando o retry acontece (sem dependência de relógio).
 *
 * TRADEOFF: se o mesmo visitante mandar a mesma mensagem duas vezes na
 * mesma conversa, a segunda será deduplicada como "falso positivo". Isso é
 * aceitável porque:
 *   1. O Chatwoot quase sempre envia payload.id (este fallback é raro)
 *   2. Deduplicar mensagem repetida é preferível a processar retry duplicado
 *   3. O TTL de 10 min limita a janela de colisão
 *
 * (Danielle Gurgel — Neurotrading, 2026-03-11 — correção pós-revisão)
 */
function gerarHashDeterministico(
  conversationId: number,
  content: string,
  senderId?: number,
): string {
  const entrada = `${conversationId}|${senderId ?? "anon"}|${content}`;
  return `chatwoot-hash-${createHash("sha256").update(entrada).digest("hex").slice(0, 16)}`;
}

/**
 * Valida o payload do webhook e extrai os dados relevantes.
 * Retorna null se o payload deve ser ignorado (mensagem de bot, evento irrelevante, etc).
 *
 * Regras de filtragem (CRÍTICAS para evitar loops infinitos):
 *   - Só processa event === "message_created"
 *   - Exige message_type === "incoming" E sender.type === "contact" (AND, não OR)
 *   - IGNORA tudo que não satisfaça AMBAS as condições
 *   - IGNORA mensagens sem conteúdo textual (imagens, etc — por ora)
 *
 * CORREÇÃO 2026-03-11 (revisão externa):
 *   O filtro original usava OR (incoming || contact), o que aceitava payloads
 *   "meio tortos" onde apenas uma condição era verdadeira. Mudado para AND
 *   para maior rigidez. Se o Chatwoot enviar payload inconsistente, logamos
 *   e ignoramos — melhor rejeitar do que arriscar loop.
 *
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
function extrairDadosMensagem(payload: PayloadWebhookChatwoot): {
  messageId: string;
  conversationId: number;
  content: string;
  contactName: string;
  contactPhone: string | undefined;
  contactEmail: string | undefined;
  inboxId: number | undefined;
  accountId: number | undefined;
} | null {
  // Filtro 1: só eventos de mensagem criada
  if (payload.event !== "message_created") {
    log.debug(`Evento ignorado: "${payload.event}" (esperado: message_created)`);
    return null;
  }

  // Filtro 2: rejeitar mensagens que NÃO são de visitantes
  //
  // Proteção anti-loop em duas camadas:
  //   a) message_type !== "incoming" → rejeita (bot envia como "outgoing")
  //   b) sender.type === "user" → rejeita (agente humano ou bot do Chatwoot)
  //
  // NOTA: O webhook do AgentBot do Chatwoot NÃO envia sender.type — vem undefined.
  // Já o webhook normal de conversa envia sender.type="contact" para visitantes.
  // Por isso aceitamos sender.type === "contact" OU undefined (ambos são visitantes).
  // Só rejeitamos explicitamente sender.type === "user" (agente/bot).
  //
  // Segurança: o loop só ocorre se processarmos mensagens "outgoing" (nosso bot
  // respondendo). O filtro message_type === "incoming" bloqueia isso na raiz.
  // O check de sender.type é camada extra de proteção.
  //
  // (Danielle Gurgel — Neurotrading, 2026-03-12 — ajuste para AgentBot webhook)
  const isIncoming = payload.message_type === "incoming";
  const isSenderAgent = payload.sender?.type === "user";

  if (!isIncoming) {
    log.debug(
      `Mensagem ignorada: message_type="${payload.message_type}" (esperado: incoming)`,
    );
    return null;
  }

  if (isSenderAgent) {
    log.debug(
      `Mensagem ignorada: sender.type="${payload.sender?.type}" (agente/bot, não visitante)`,
    );
    return null;
  }

  // Filtro 3: precisa ter conteúdo textual
  const content = (payload.content ?? "").trim();
  if (!content) {
    log.debug("Mensagem ignorada: sem conteúdo textual");
    return null;
  }

  // Filtro 4: precisa ter conversation ID
  const conversationId = payload.conversation?.id;
  if (typeof conversationId !== "number") {
    log.warn("Mensagem ignorada: conversation.id ausente ou não-numérico");
    return null;
  }

  // Gerar messageId para deduplicação — usa o ID do Chatwoot se disponível.
  // CORREÇÃO 2026-03-11 (revisão externa): se o ID não vier, usa hash determinístico
  // em vez de randomUUID. Isso garante que retry do mesmo webhook gere o mesmo
  // messageId e seja corretamente deduplicado.
  const messageId =
    typeof payload.id === "number"
      ? `chatwoot-msg-${payload.id}`
      : gerarHashDeterministico(conversationId, content, payload.sender?.id);

  // Extrair dados do contato (best-effort)
  const contactName = payload.sender?.name ?? payload.contact?.name ?? "Visitante";
  const contactPhone = payload.contact?.phone_number ?? undefined;
  const contactEmail = (payload.contact?.email ?? undefined) as string | undefined;

  return {
    messageId,
    conversationId,
    content,
    contactName,
    contactPhone,
    contactEmail,
    inboxId: payload.inbox?.id,
    accountId: payload.account?.id,
  };
}

/**
 * Limita texto de mensagem a 6000 caracteres.
 * Mesma lógica de sanitizarTexto em ponte-chatwoot.ts.
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
const MAX_TEXTO_MSG = 6000;
function sanitizarTexto(texto: string): string {
  if (texto.length <= MAX_TEXTO_MSG) {
    return texto;
  }
  return texto.slice(0, MAX_TEXTO_MSG) + "…[truncado]";
}

/**
 * Sanitiza nome de contato antes de logar.
 * Remove caracteres de controle e limita a 100 chars para evitar
 * poluição de log com nomes maliciosos ou abusivos.
 * (Danielle Gurgel — Neurotrading, 2026-03-11 — correção pós-revisão)
 */
function sanitizarNomeParaLog(nome: string): string {
  // eslint-disable-next-line no-control-regex
  const limpo = nome.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (limpo.length <= 100) { return limpo; }
  return limpo.slice(0, 100) + "…";
}

/**
 * Sanitiza nome de contato para uso no prompt do agente.
 * Responsabilidade diferente de sanitizarNomeParaLog:
 *   - Log: preocupação é poluição/injeção em log files
 *   - Prompt: preocupação é injeção de prompt / contexto enganoso
 *
 * Remove caracteres de controle, quebras de linha (evita injeção de
 * contexto no prompt), e limita a 80 chars (nome real não precisa de mais).
 * (Danielle Gurgel — Neurotrading, 2026-03-11 — correção pós-revisão)
 */
function sanitizarNomeParaPrompt(nome: string): string {
  // eslint-disable-next-line no-control-regex
  const limpo = nome.replace(/[\x00-\x1f\x7f\n\r]/g, " ").replace(/\s+/g, " ").trim();
  if (limpo.length <= 80) { return limpo; }
  return limpo.slice(0, 80);
}

// =============================================================================
// Check de handoff — verifica se a conversa está sob controle humano
// (Danielle Gurgel — Neurotrading, 2026-03-11 — correção pós-revisão)
//
// PROBLEMA RESOLVIDO:
//   Quando um agente humano assume uma conversa no Chatwoot (clica "Resolver"
//   ou "Assign"), o bot NÃO deve responder. Sem esse check, o bot e o humano
//   responderiam ao mesmo tempo — experiência péssima pro visitante.
//
// COMO FUNCIONA:
//   Consulta a API do Chatwoot para obter o status da conversa.
//   Se o status for "resolved" ou se houver agente humano atribuído (assignee),
//   considera que a conversa está em handoff e retorna true.
//
// POR QUE não usar o handoff-store do WhatsApp?
//   O handoff-store é indexado por TELEFONE, e visitantes do widget não têm
//   telefone (são anônimos). Precisamos checar o estado diretamente no Chatwoot
//   pela API de conversa.
// =============================================================================

/**
 * Verifica se uma conversa está em handoff (humano assumiu).
 * Consulta GET /conversations/{id} na API do Chatwoot.
 *
 * Retorna true se:
 *   - status === "resolved" (conversa encerrada pelo humano)
 *   - assignee presente (humano atribuído à conversa)
 *
 * Retorna false se:
 *   - status === "open" ou "pending" sem assignee
 *   - Falha na API (fail-open: na dúvida, deixa o bot responder)
 *
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
async function conversaEmHandoff(
  cwCfg: ChatwootConfig,
  conversationId: number,
): Promise<boolean> {
  try {
    const baseUrl = (cwCfg.baseUrl ?? "").replace(/\/+$/, "");
    const url = `${baseUrl}/api/v1/accounts/${cwCfg.accountId}/conversations/${conversationId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { api_access_token: cwCfg.apiToken! },
        signal: controller.signal,
      });

      if (!res.ok) {
        log.warn(`Check de handoff falhou (HTTP ${res.status}) para conv=${conversationId}`);
        return false; // fail-open: na dúvida, bot responde
      }

      const data = (await res.json()) as {
        status?: string;
        meta?: {
          assignee?: { id?: number; name?: string } | null;
        };
      };

      // Se conversa está resolvida, bot fica quieto
      if (data.status === "resolved") {
        log.info(`Conversa ${conversationId} está resolvida — bot não responde`);
        return true;
      }

      // Se há agente humano atribuído, bot fica quieto
      if (data.meta?.assignee?.id) {
        log.info(
          `Conversa ${conversationId} tem agente atribuído ` +
            `(${data.meta.assignee.name ?? "?"}) — bot não responde`,
        );
        return true;
      }

      return false;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    // Erro de rede, timeout, etc — fail-open (bot responde)
    log.warn(
      `Erro ao checar handoff para conv=${conversationId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

// =============================================================================
// Handler principal
// =============================================================================

const MAX_BODY_BYTES = 512 * 1024; // 512 KB (generoso para webhooks do Chatwoot)

/**
 * Handler HTTP do webhook Chatwoot (canal de entrada — AgentBot).
 * Chamado pelo dispatcher em server-http.ts para o subpath "chatwoot-inbound".
 *
 * Autenticação: Bearer token do hooks (já validado pelo dispatcher antes
 * de chegar aqui — este handler NÃO refaz a validação de token).
 * O Chatwoot AgentBot suporta enviar headers customizados no webhook URL,
 * diferente do webhook de conversa (que motivou o token-no-path para handoff).
 *
 * Retorna true se a requisição foi tratada (response enviada).
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
export async function handleChatwootInboundWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { url: URL; logHooks: SubsystemLogger },
): Promise<boolean> {
  // Só aceita POST (webhook do Chatwoot sempre é POST)
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const cfg = loadConfig();
  const cwCfg = obterConfigChatwootEntrada(cfg);

  if (!cwCfg) {
    log.warn("Webhook Chatwoot inbound recebido, mas integração não está configurada/habilitada");
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Chatwoot integration not configured");
    return true;
  }

  // 1. Ler body cru
  const rawBody = await lerBodyCru(req, MAX_BODY_BYTES);
  if (!rawBody) {
    log.warn("Body do webhook Chatwoot ausente, excede limite ou timeout");
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request");
    return true;
  }

  // 2. Responder 200 IMEDIATAMENTE — processamento é fire-and-forget.
  // O Chatwoot espera resposta rápida, senão pode reenviar.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("OK");

  // 3. Parsear JSON (após responder 200)
  let payload: PayloadWebhookChatwoot;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as PayloadWebhookChatwoot;
  } catch {
    log.warn("JSON inválido no webhook Chatwoot (já respondemos 200)");
    return true;
  }

  // 4. Extrair e validar dados da mensagem
  const dados = extrairDadosMensagem(payload);
  if (!dados) {
    // Mensagem filtrada (bot, evento irrelevante, sem conteúdo) — já logamos o motivo
    return true;
  }

  // 5. Deduplicação: se já processamos este messageId, pular
  if (processedIds.has(dados.messageId)) {
    log.debug(`Mensagem duplicada ignorada: ${dados.messageId}`);
    return true;
  }
  processedIds.set(dados.messageId, Date.now());

  log.info(
    `Mensagem recebida via Chatwoot widget: conv=${dados.conversationId}, ` +
      `contato="${sanitizarNomeParaLog(dados.contactName)}", inbox=${dados.inboxId ?? "?"}, ` +
      `tamanho=${dados.content.length} chars`,
  );

  // 6. Enfileirar processamento — mutex por conversa garante ordem
  // (Danielle Gurgel — Neurotrading, 2026-03-11 — correção pós-revisão)
  enfileirarPorConversa(dados.conversationId, async () => {
    try {
      await processarMensagemChatwoot(cfg, cwCfg, dados);
    } catch (err) {
      log.error(`Erro ao processar mensagem Chatwoot conv=${dados.conversationId}`, {
        error: err instanceof Error ? err.stack : String(err),
        conversationId: dados.conversationId,
        messageId: dados.messageId,
      });
    }
  });

  return true;
}

// =============================================================================
// Processamento de mensagem individual
// =============================================================================

/**
 * Processa uma mensagem individual do widget do Chatwoot.
 *
 * Fluxo:
 *   1. Verifica se a conversa está em handoff (humano assumiu)
 *   2. Constrói uma CronJob fictícia com a mensagem do visitante
 *   3. Roda o agente via runCronIsolatedAgentTurn (deliver=false)
 *   4. Captura o outputText do agente
 *   5. Envia a resposta de volta ao Chatwoot via enviarMensagemChatwoot
 *
 * Session key: "chatwoot-conv-{conversationId}"
 *   Cada conversa no Chatwoot tem uma session key única. Isso permite que o
 *   agente mantenha contexto entre mensagens da mesma conversa (o session
 *   transcript é persistido por session key).
 *
 * SERIALIZAÇÃO: esta função é chamada via enfileirarPorConversa(), ou seja,
 * NUNCA roda em paralelo para a mesma conversa. A próxima mensagem só começa
 * a ser processada quando esta terminar. Isso garante que o agente vê o
 * histórico correto e as respostas saem na ordem certa.
 *
 * (Danielle Gurgel — Neurotrading, 2026-03-11)
 */
async function processarMensagemChatwoot(
  cfg: ReturnType<typeof loadConfig>,
  cwCfg: ChatwootConfig,
  dados: {
    messageId: string;
    conversationId: number;
    content: string;
    contactName: string;
    contactPhone: string | undefined;
    contactEmail: string | undefined;
    inboxId: number | undefined;
    accountId: number | undefined;
  },
): Promise<void> {
  const sessionKey = `chatwoot-conv-${dados.conversationId}`;
  const textoSanitizado = sanitizarTexto(dados.content);
  const nomeParaLog = sanitizarNomeParaLog(dados.contactName);
  const nomeParaPrompt = sanitizarNomeParaPrompt(dados.contactName);

  log.info(
    `Processando mensagem Chatwoot: session="${sessionKey}", contato="${nomeParaLog}"`,
  );

  // ─── CHECK DE HANDOFF ─────────────────────────────────────────────────────
  // Antes de chamar o agente, verifica se a conversa está sob controle humano.
  // Se estiver, o bot fica quieto — o humano está respondendo.
  // (Danielle Gurgel — Neurotrading, 2026-03-11 — correção pós-revisão)
  // ─────────────────────────────────────────────────────────────────────────
  const emHandoff = await conversaEmHandoff(cwCfg, dados.conversationId);
  if (emHandoff) {
    log.info(
      `Mensagem de conv=${dados.conversationId} ignorada: conversa em handoff (humano assumiu)`,
    );
    return;
  }

  // Importar dependências via lazy-init (evita import circular)
  const runCronIsolatedAgentTurn = await getRunCronIsolatedAgentTurn();
  const enviarMensagemChatwoot = await getEnviarMensagemChatwoot();
  const createDefaultDeps = await getCreateDefaultDeps();

  // Construir dependências do CLI (necessário para runCronIsolatedAgentTurn)
  const deps = createDefaultDeps();

  // Construir CronJob fictícia — o agente não sabe que a mensagem veio do Chatwoot.
  // Ele vê apenas o texto e o contexto da sessão. deliver=false porque nós mesmos
  // vamos enviar a resposta via API REST do Chatwoot.
  // (Danielle Gurgel — Neurotrading, 2026-03-11)
  const now = Date.now();
  const jobId = randomUUID();
  const job = {
    id: jobId,
    name: `chatwoot-inbound-conv-${dados.conversationId}`,
    enabled: true as const,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "at" as const, at: new Date(now).toISOString() },
    sessionTarget: "isolated" as const,
    wakeMode: "now" as const,
    payload: {
      kind: "agentTurn" as const,
      message: textoSanitizado,
      deliver: false, // NÃO entregar via pipeline — nós enviamos manualmente
    },
    state: { nextRunAtMs: now },
  };

  // Montar a mensagem que o agente vai receber.
  // Inclui nome do visitante para contexto — o agente pode personalizar a resposta.
  const mensagemParaAgente = `[Mensagem do widget do site — visitante: ${nomeParaPrompt}]\n\n${textoSanitizado}`;

  let resultado;
  try {
    resultado = await runCronIsolatedAgentTurn({
      cfg,
      deps,
      job,
      message: mensagemParaAgente,
      sessionKey,
      // agentId undefined = usa o agente padrão (Fellipe)
      lane: "chatwoot-inbound",
    });
  } catch (err) {
    log.error(
      `Falha ao rodar agente para conv=${dados.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Tenta enviar mensagem de fallback para o visitante não ficar sem resposta
    try {
      await enviarMensagemChatwoot(
        cfg,
        dados.conversationId,
        "Desculpe, estou com dificuldades técnicas no momento. " +
          "Por favor, tente novamente em alguns instantes ou entre em contato pelo WhatsApp.",
      );
    } catch {
      log.warn(`Falha ao enviar mensagem de fallback para conv=${dados.conversationId}`);
    }
    return;
  }

  // Verificar resultado do agente
  if (resultado.status === "error") {
    log.warn(
      `Agente retornou erro para conv=${dados.conversationId}: ${resultado.error ?? "desconhecido"}`,
    );
    // Tenta enviar mensagem de fallback
    try {
      await enviarMensagemChatwoot(
        cfg,
        dados.conversationId,
        "Desculpe, estou com dificuldades técnicas no momento. " +
          "Por favor, tente novamente em alguns instantes ou entre em contato pelo WhatsApp.",
      );
    } catch {
      log.warn(`Falha ao enviar mensagem de fallback para conv=${dados.conversationId}`);
    }
    return;
  }

  // Extrair texto da resposta do agente
  const respostaAgente = (resultado.outputText ?? "").trim();
  if (!respostaAgente) {
    log.warn(`Agente retornou resposta vazia para conv=${dados.conversationId}`);
    return;
  }

  // Enviar resposta do agente de volta ao Chatwoot
  log.info(
    `Enviando resposta do agente para conv=${dados.conversationId} ` +
      `(${respostaAgente.length} chars)`,
  );

  const resultadoEnvio = await enviarMensagemChatwoot(cfg, dados.conversationId, respostaAgente);
  if (resultadoEnvio.ok) {
    log.info(
      `Resposta enviada com sucesso para conv=${dados.conversationId} ` +
        `(messageId=${resultadoEnvio.messageId ?? "?"})`,
    );
  } else {
    log.error(`Falha ao enviar resposta para conv=${dados.conversationId}`);
  }
}
