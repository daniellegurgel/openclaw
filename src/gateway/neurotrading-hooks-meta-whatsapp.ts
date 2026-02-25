/**
 * =============================================================================
 * HANDLER HTTP — Webhook Meta Cloud API para OpenClaw
 * =============================================================================
 *
 * Autora: Danielle Gurgel
 * Criado em: 2026-02-24
 *
 * -----------------------------------------------------------------------------
 * CONTEXTO
 * -----------------------------------------------------------------------------
 * Este handler recebe webhooks do Meta (Cloud API) e os converte em mensagens
 * que passam pelo pipeline de inbound existente (processMessage).
 *
 * Fluxo:
 *   GET  → Verificação de webhook (challenge do Meta)
 *   POST → Mensagem de lead → processMessage → Fellipe responde via Cloud API
 *
 * Decisões técnicas validadas:
 *   - accountId "default" (casa com bindings existentes)
 *   - msg.id undefined (evita maybeSendAckReaction via Baileys)
 *   - Resposta HTTP 200 imediata (antes do processamento)
 *   - Fire-and-forget para processamento de mensagens
 *   - HMAC-SHA256 com raw body (antes de JSON.parse)
 *   - Deduplicação por messageId (Meta pode reenviar após crash pós-200)
 *
 * =============================================================================
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  type MetaCloudApiConfig,
  construirMensagemSintetica,
  extrairMensagensDoWebhook,
  validarAssinaturaWebhook,
  verificarChallengeWebhook,
} from "../integrations/neurotrading-meta-cloud-api.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { isHandoffActive } from "../sessions/handoff-store.js";
import { getChildLogger } from "../logging/logger.js";

const log = createSubsystemLogger("meta-cloud-api-webhook");

// Echo tracker — processMessage exige callbacks echoHas/echoForget/rememberSentText.
// Cloud API NÃO ecoa mensagens enviadas (diferente do Baileys), então rememberSentText
// é noop e nada entra no Set. Os callbacks existem apenas para satisfazer a interface.
// Sem risco de memory leak: Set permanece vazio em operação normal.
const echoSet = new Set<string>();

// Deduplicação por messageId — protege contra reprocessamento quando o Meta
// reenvia um webhook (ex.: crash pós-200, timeout de rede).
// Map<messageId, timestampMs> com cleanup periódico (TTL 10 min).
const processedIds = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutos
const DEDUP_CLEANUP_INTERVAL_MS = 60 * 1000; // cleanup a cada 1 min

setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedIds) {
    if (now - ts > DEDUP_TTL_MS) { processedIds.delete(id); }
  }
}, DEDUP_CLEANUP_INTERVAL_MS).unref(); // unref() para não impedir shutdown do processo

// Lazy-init para imports dinâmicos (evita import circular com auto-reply → agents).
// Node faz cache de módulos, mas a Promise resolve instantaneamente após o primeiro import.
let _processMessage: typeof import("../web/auto-reply/monitor/process-message.js")["processMessage"] | null = null;
let _getReplyFromConfig: typeof import("../auto-reply/reply.js")["getReplyFromConfig"] | null = null;

async function getProcessMessage() {
  if (!_processMessage) {
    _processMessage = (await import("../web/auto-reply/monitor/process-message.js")).processMessage;
  }
  return _processMessage;
}

async function getReplyResolver() {
  if (!_getReplyFromConfig) {
    _getReplyFromConfig = (await import("../auto-reply/reply.js")).getReplyFromConfig;
  }
  return _getReplyFromConfig;
}

// =============================================================================
// Helpers
// =============================================================================

const BODY_READ_TIMEOUT_MS = 10_000; // 10s — proteção contra slowloris

/**
 * Lê o body cru da requisição como Buffer.
 * CRÍTICO: deve ser chamado ANTES de qualquer JSON.parse para que a
 * validação HMAC funcione com o payload original.
 * Inclui timeout para proteção contra conexões travadas (slowloris).
 */
function lerBodyCru(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log.warn("Timeout ao ler body do webhook Meta (slowloris?)");
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
 * Obtém a config do Meta Cloud API a partir do config geral.
 * Retorna null se desabilitada ou incompleta. Loga quais campos faltam.
 */
function obterConfigMeta(
  cfg: { integrations?: { metaCloudApi?: MetaCloudApiConfig } },
): MetaCloudApiConfig | null {
  const meta = cfg.integrations?.metaCloudApi;
  if (!meta?.enabled) {
    return null;
  }

  const camposObrigatorios = ["phoneNumberId", "accessToken", "appSecret", "verifyToken", "selfNumber"] as const;
  const faltando = camposObrigatorios.filter((campo) => !meta[campo]);
  if (faltando.length > 0) {
    log.warn(`Config Meta Cloud API incompleta — faltam: [${faltando.join(", ")}]`);
    return null;
  }
  return meta;
}

// =============================================================================
// Handler principal
// =============================================================================

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB (generoso para webhooks do Meta)

/**
 * Handler HTTP do webhook Meta Cloud API.
 * Chamado pelo dispatcher em server-http.ts para o subpath "meta-whatsapp".
 *
 * Retorna true se a requisição foi tratada (response enviada).
 */
export async function handleMetaWhatsAppWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { url: URL; logHooks: SubsystemLogger },
): Promise<boolean> {
  const cfg = loadConfig();
  const metaCfg = obterConfigMeta(cfg);

  if (!metaCfg) {
    log.warn("Webhook Meta Cloud API recebido, mas integração não está configurada/habilitada");
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Meta Cloud API integration not configured");
    return true;
  }

  // =========================================================================
  // GET → Verificação de webhook (challenge)
  // =========================================================================
  if (req.method === "GET") {
    const resultado = verificarChallengeWebhook(opts.url, metaCfg.verifyToken!);
    if (resultado.ok) {
      log.info("Webhook Meta verificado com sucesso (challenge respondido)");
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(resultado.challenge);
    } else {
      log.warn(`Falha na verificação do webhook Meta: ${resultado.error}`);
      res.statusCode = resultado.status;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(resultado.error);
    }
    return true;
  }

  // =========================================================================
  // POST → Mensagem de lead
  // =========================================================================
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // 1. Ler body cru (Buffer) — ANTES de qualquer parse, para validação HMAC
  const rawBody = await lerBodyCru(req, MAX_BODY_BYTES);
  if (!rawBody) {
    log.warn("Body do webhook Meta ausente, excede limite ou timeout");
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request");
    return true;
  }

  // 2. Validar assinatura HMAC-SHA256
  const signatureHeader = req.headers["x-hub-signature-256"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!signature || !validarAssinaturaWebhook(rawBody, signature, metaCfg.appSecret!)) {
    log.warn("Assinatura HMAC inválida no webhook Meta");
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Unauthorized");
    return true;
  }

  // 3. Responder 200 IMEDIATAMENTE — Meta exige resposta rápida, senão reenvia
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("OK");

  // 4. Parsear JSON e extrair mensagens (após responder 200)
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody.toString("utf-8")) as Record<string, unknown>;
  } catch {
    log.warn("JSON inválido no webhook Meta (já respondemos 200)");
    return true;
  }

  const mensagens = extrairMensagensDoWebhook(payload, metaCfg.selfNumber);
  if (mensagens.length === 0) {
    log.debug("Webhook Meta sem mensagens extraíveis (status update ou eco)");
    return true;
  }

  log.info(`Webhook Meta: ${mensagens.length} mensagem(ns) recebida(s)`);

  // 5. Processar cada mensagem (fire-and-forget)
  for (const mensagem of mensagens) {
    // Deduplicação: se já processamos este messageId, pular
    if (mensagem.messageId && processedIds.has(mensagem.messageId)) {
      log.debug(`Mensagem duplicada ignorada: ${mensagem.messageId}`);
      continue;
    }
    if (mensagem.messageId) {
      processedIds.set(mensagem.messageId, Date.now());
    }

    void (async () => {
      try {
        await processarMensagemCloudApi(cfg, metaCfg, mensagem);
      } catch (err) {
        log.error(`Erro ao processar mensagem Cloud API de ${mensagem.waId}`, {
          error: err instanceof Error ? err.stack : String(err),
          waId: mensagem.waId,
          messageId: mensagem.messageId,
        });
      }
    })();
  }

  return true;
}

// =============================================================================
// Processamento de mensagem individual
// =============================================================================

/**
 * Processa uma mensagem individual do Cloud API.
 * Constrói mensagem sintética → resolve rota → verifica handoff → processMessage.
 */
async function processarMensagemCloudApi(
  cfg: ReturnType<typeof loadConfig>,
  metaCfg: MetaCloudApiConfig,
  mensagem: { waId: string; texto: string; nome?: string; messageId?: string; timestamp?: number },
): Promise<void> {
  const msgSintetica = construirMensagemSintetica(mensagem, metaCfg);
  const senderE164 = msgSintetica.senderE164!;

  // Resolver rota do agente (accountId "default" para casar com bindings)
  const route = resolveAgentRoute({
    cfg,
    channel: "whatsapp",
    accountId: "default",
    peer: { kind: "dm", id: senderE164 },
  });

  log.info(
    `Mensagem de ${senderE164} (${mensagem.nome ?? "?"}) → agente ${route.agentId} ` +
    `(session: ${route.sessionKey}, matched by: ${route.matchedBy})`,
  );

  // Verificar handoff ativo — se ativo, o bot não responde
  const handoff = isHandoffActive(senderE164);
  if (handoff) {
    log.info(`Handoff ativo para ${senderE164} — mensagem ignorada pelo bot`);
    return;
  }

  // Importar processMessage e replyResolver via lazy-init (evita import circular)
  const processMessage = await getProcessMessage();
  const replyResolver = await getReplyResolver();

  const replyLogger = getChildLogger({ subsystem: "meta-cloud-api-reply" });

  // backgroundTasks: Set local para rastrear tasks assíncronas (updateLastRoute, recordSessionMeta).
  // Awaited após processMessage para garantir que persistências completem.
  const backgroundTasks = new Set<Promise<unknown>>();

  await processMessage({
    cfg,
    msg: msgSintetica,
    route,
    groupHistoryKey: "",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: `cloud-api:${metaCfg.phoneNumberId}`,
    verbose: false,
    maxMediaBytes: 5 * 1024 * 1024,
    replyResolver,
    replyLogger,
    backgroundTasks,
    rememberSentText: () => {
      // noop — Cloud API não ecoa mensagens enviadas (diferente do Baileys).
      // echoSet permanece vazio; echoHas/echoForget existem apenas para a interface.
    },
    echoHas: (key: string) => echoSet.has(key),
    echoForget: (key: string) => {
      echoSet.delete(key);
    },
    buildCombinedEchoKey: (p: { sessionKey: string; combinedBody: string }) =>
      `${p.sessionKey}::${p.combinedBody}`,
  });

  // Aguardar tasks de background (updateLastRoute, recordSessionMeta, etc.)
  if (backgroundTasks.size > 0) {
    const results = await Promise.allSettled(backgroundTasks);
    for (const result of results) {
      if (result.status === "rejected") {
        log.warn(`Background task falhou para ${senderE164}: ${result.reason}`);
      }
    }
  }

  log.info(`Processamento concluído para ${senderE164}`);
}
