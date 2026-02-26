/**
 * =============================================================================
 * EXTENSÃO: Canal de entrega via API Meta (Neurotrading)
 * =============================================================================
 *
 * Autora: Danielle Gurgel
 * Criado em: 2026-02-25
 *
 * -----------------------------------------------------------------------------
 * O QUE FAZ
 * -----------------------------------------------------------------------------
 * Registra o canal "api-meta" no OpenClaw. Quando o n8n (ou qualquer chamador)
 * manda `channel: "api-meta"` no POST /hooks/agent, a mensagem do agente é
 * entregue pela API Meta (Graph API do Facebook) usando o número 1404
 * (Neurotrading Suporte), em vez de pelo Baileys/WhatsApp Web (número 2223).
 *
 * O canal usa funções que já existem no OpenClaw:
 *   - enviarTextoCloudApi()    → envia texto via Graph API
 *   - enviarMidiaCloudApi()    → envia mídia via Graph API
 *   - enviarTemplateCloudApi() → envia template aprovado (leads frios)
 *   - espelharMensagemSaida()  → mostra a conversa no Chatwoot
 *
 * TEMPLATES (leads frios):
 * Se o payload contém channelData["api-meta"].template, o canal usa
 * enviarTemplateCloudApi() em vez de texto livre. Isso é obrigatório para
 * leads que não interagiram nas últimas 24h (erro 131047 do Meta).
 *
 * As credenciais (accessToken, phoneNumberId, etc.) são lidas do openclaw.json
 * no bloco integrations.metaCloudApi.
 *
 * -----------------------------------------------------------------------------
 * POR QUE EXISTE
 * -----------------------------------------------------------------------------
 * A Neurotrading usa dois números WhatsApp:
 *   - 91558-2223 (Neurotrading) — atendimento diário via Baileys
 *   - 97868-1404 (Neurotrading Suporte) — campanhas via API Meta
 *
 * O hooks/agent originalmente só sabia entregar pelo Baileys (canal "whatsapp").
 * Esta extensão adiciona o canal "api-meta" como alternativa de entrega.
 *
 * =============================================================================
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import type {
  ChannelPlugin,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadContext,
  ChannelAccountSnapshot,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  normalizeE164,
  enviarTextoCloudApi,
  enviarMidiaCloudApi,
  enviarTemplateCloudApi,
  espelharMensagemSaida,
  type MetaCloudApiConfig,
  type TemplateParams,
} from "openclaw/plugin-sdk";

// =============================================================================
// Logger — capturado no register(), usado em todo o módulo
// =============================================================================

/**
 * Logger do subsistema do plugin. Inicializado com fallback para console;
 * substituído pelo logger real do OpenClaw quando register() é chamado.
 */
let log: PluginLogger = {
  info: (msg: string) => console.log(`[api-meta] ${msg}`),
  warn: (msg: string) => console.warn(`[api-meta] ${msg}`),
  error: (msg: string) => console.error(`[api-meta] ${msg}`),
};

// =============================================================================
// Constantes
// =============================================================================

/** Limite de texto da API Meta (WhatsApp Business). */
const META_TEXT_LIMIT = 4096;

/**
 * Máximo de tentativas para erros temporários da API Meta (429, 500, 502, 503, 504).
 * Backoff exponencial: 1s, 2s, 4s — ou Retry-After se informado pelo Meta.
 */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extrai a config do Meta Cloud API do openclaw.json.
 * Lança erro se não estiver configurada ou habilitada.
 */
function obterConfigMetaObrigatoria(cfg: OpenClawConfig): MetaCloudApiConfig {
  const meta = (cfg as Record<string, unknown> & { integrations?: { metaCloudApi?: MetaCloudApiConfig } })
    .integrations?.metaCloudApi;
  if (!meta?.enabled) {
    throw new Error(
      "Canal api-meta: integrations.metaCloudApi não está habilitado no openclaw.json. " +
      "Configure enabled: true, phoneNumberId, accessToken, appSecret, verifyToken e selfNumber.",
    );
  }
  if (!meta.phoneNumberId || !meta.accessToken) {
    throw new Error(
      "Canal api-meta: phoneNumberId ou accessToken ausente em integrations.metaCloudApi.",
    );
  }
  return meta;
}

/** Códigos HTTP temporários da API Meta que merecem retry. */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/**
 * Detecta erros temporários da API Meta.
 * Prioriza propriedade status/statusCode do erro (mais confiável que regex).
 * Regex no message é fallback para SDKs que embutem o código na string.
 */
function isTransientError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const resp = e.response;
    const status = e.status ?? e.statusCode
      ?? (resp && typeof resp === "object" ? (resp as Record<string, unknown>).status : undefined);
    if (typeof status === "number" && TRANSIENT_STATUS_CODES.has(status)) { return true; }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504)\b/.test(msg)
    || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|AbortError|rate\s*limit/i.test(msg);
}

/**
 * Extrai o tempo de espera do header Retry-After (em ms).
 * O Meta pode retornar segundos (inteiro) ou data HTTP.
 * Retorna undefined se não encontrar ou não for parseable.
 * Cap de 60s para não travar o processo.
 */
function extrairRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== "object") { return undefined; }
  const e = err as Record<string, unknown>;
  const resp = e.response as Record<string, unknown> | undefined;
  const headers = resp?.headers;
  if (!headers || typeof headers !== "object") { return undefined; }

  // Headers podem vir como objeto plain ou como Headers (fetch API)
  let retryAfter: string | undefined;
  if (typeof (headers as Record<string, unknown>).get === "function") {
    retryAfter = (headers as { get: (k: string) => string | null }).get("retry-after") ?? undefined;
  } else {
    retryAfter = (headers as Record<string, string>)["retry-after"];
  }

  if (!retryAfter) { return undefined; }

  // Tenta como número de segundos
  const secs = Number(retryAfter);
  if (!Number.isNaN(secs) && secs > 0) {
    return Math.min(secs * 1000, 60_000);
  }

  // Tenta como data HTTP (RFC 7231)
  const date = Date.parse(retryAfter);
  if (!Number.isNaN(date)) {
    const diff = date - Date.now();
    return diff > 0 ? Math.min(diff, 60_000) : undefined;
  }

  return undefined;
}

/**
 * Espelha mensagem no Chatwoot de forma segura.
 * espelharMensagemSaida hoje é sync (fire-and-forget interno), mas este wrapper
 * cobre ambos os casos (sync e async) sem risco de unhandled rejection.
 */
function espelharSeguro(cfg: OpenClawConfig, to: string, text: string): void {
  try {
    const maybe = espelharMensagemSaida(cfg, to, text) as unknown;
    if (maybe && typeof (maybe as { then?: unknown }).then === "function") {
      void (maybe as Promise<unknown>).catch(() => {});
    }
  } catch (err) {
    log.warn(`Espelhamento Chatwoot falhou para ${to}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Executa uma função com retry + backoff exponencial para erros temporários.
 * Respeita header Retry-After do Meta em erros 429.
 * Erros permanentes (400, 401, etc.) são lançados imediatamente.
 */
async function comRetry<T>(fn: () => Promise<T>, descricao: string): Promise<T> {
  let ultimoErro: unknown;
  for (let tentativa = 0; tentativa < MAX_RETRIES; tentativa++) {
    try {
      return await fn();
    } catch (err) {
      ultimoErro = err;
      if (!isTransientError(err) || tentativa === MAX_RETRIES - 1) {
        throw err;
      }
      // Retry-After do Meta tem prioridade; senão, backoff exponencial
      const retryAfter = extrairRetryAfterMs(err);
      const espera = retryAfter ?? RETRY_BASE_MS * Math.pow(2, tentativa);
      log.warn(
        `${descricao} falhou (tentativa ${tentativa + 1}/${MAX_RETRIES}), ` +
        `retry em ${espera}ms${retryAfter ? " (Retry-After)" : ""}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw ultimoErro;
}

// =============================================================================
// Helpers — template via channelData
// =============================================================================

/**
 * Formato esperado em payload.channelData["api-meta"].
 * Se `template` estiver presente, o canal envia template em vez de texto livre.
 *
 * Exemplo de channelData no ReplyPayload:
 * {
 *   "api-meta": {
 *     "idempotencyKey": "campanha-2026-02:+5511999999999",
 *     "template": {
 *       "name": "prospeccao_fellipe_v1",
 *       "language": "pt_BR",
 *       "variables": ["João"],
 *       "headerImageUrl": "https://..."
 *     }
 *   }
 * }
 */
type ApiMetaChannelData = {
  /** Chave de idempotência — se repetida dentro de 24h, a mensagem não é reenviada. */
  idempotencyKey?: string;
  template?: TemplateParams;
};

/**
 * Extrai template params de channelData, se presente.
 * Valida que pelo menos `name` e `language` existem.
 */
function extrairTemplate(channelData: Record<string, unknown> | undefined): TemplateParams | undefined {
  if (!channelData) { return undefined; }
  const data = channelData["api-meta"] as ApiMetaChannelData | undefined;
  if (!data?.template) { return undefined; }
  const t = data.template;
  if (!t.name || !t.language) {
    log.warn(`Template incompleto no channelData: name=${t.name ?? "(vazio)"}, language=${t.language ?? "(vazio)"}`);
    return undefined;
  }
  // Alerta se variables está ausente — pode causar erro 132000 no Meta
  // se o template aprovado exige parâmetros
  if (!t.variables || t.variables.length === 0) {
    log.warn(`Template '${t.name}' enviado sem variables — se o template exigir parâmetros, o Meta rejeitará`);
  }
  return t;
}

// =============================================================================
// Idempotência persistente — evita reenvio quando n8n retenta por timeout
// =============================================================================

/** TTL do cache de idempotência: 24h (janela de conversa do Meta). */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Intervalo de limpeza de chaves expiradas: 1h. */
const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type IdempotencyEntry = { messageId: string; channel: string; timestamp: number };

/**
 * Caminho do arquivo de idempotência.
 * Definido no register() — usa stateDir do OpenClaw (~/.openclaw/).
 * Enquanto não for inicializado, usa fallback em memória.
 */
let idempotencyFilePath: string | null = null;

/** Cache em memória — sincronizado com o arquivo em disco. */
let idempotencyCache = new Map<string, IdempotencyEntry>();

/** Carrega o cache do disco. Chamado no register() e após cleanup. */
function carregarIdempotencyDoDisco(): void {
  if (!idempotencyFilePath) { return; }
  try {
    if (!fs.existsSync(idempotencyFilePath)) { return; }
    const raw = fs.readFileSync(idempotencyFilePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, IdempotencyEntry>;
    idempotencyCache = new Map(Object.entries(data));
  } catch (err) {
    log.warn(`Falha ao ler cache de idempotência: ${err instanceof Error ? err.message : String(err)}`);
    idempotencyCache = new Map();
  }
}

/** Salva o cache em disco de forma atômica (write + rename). */
function salvarIdempotencyEmDisco(): void {
  if (!idempotencyFilePath) { return; }
  try {
    const obj: Record<string, IdempotencyEntry> = {};
    for (const [k, v] of idempotencyCache) { obj[k] = v; }
    const tmpPath = idempotencyFilePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(obj), "utf-8");
    fs.renameSync(tmpPath, idempotencyFilePath);
  } catch (err) {
    log.warn(`Falha ao salvar cache de idempotência: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Limpa entradas expiradas do cache e persiste. */
function limparIdempotencyExpiradas(): void {
  const agora = Date.now();
  let removidas = 0;
  for (const [key, entry] of idempotencyCache) {
    if (agora - entry.timestamp >= IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
      removidas++;
    }
  }
  if (removidas > 0) {
    salvarIdempotencyEmDisco();
    log.info(`Idempotência: ${removidas} chaves expiradas removidas, ${idempotencyCache.size} restantes`);
  }
}

// Limpeza periódica — unref() para não impedir o processo de sair
const cleanupTimer = setInterval(limparIdempotencyExpiradas, IDEMPOTENCY_CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
  cleanupTimer.unref();
}

/**
 * Extrai a chave de idempotência do channelData ou de um campo direto.
 */
function extrairIdempotencyKey(
  channelData: Record<string, unknown> | undefined,
  directKey?: string,
): string | undefined {
  if (directKey && directKey.length > 0) { return directKey; }
  if (!channelData) { return undefined; }
  const data = channelData["api-meta"] as ApiMetaChannelData | undefined;
  const key = data?.idempotencyKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/**
 * Verifica se a chave já foi processada. Retorna o resultado cacheado ou undefined.
 */
function verificarIdempotency(key: string): IdempotencyEntry | undefined {
  const cached = idempotencyCache.get(key);
  if (!cached) { return undefined; }
  if (Date.now() - cached.timestamp >= IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return undefined;
  }
  return cached;
}

/**
 * Registra resultado no cache de idempotência e persiste em disco.
 */
function registrarIdempotency(key: string, result: { channel: string; messageId: string }): void {
  idempotencyCache.set(key, { ...result, timestamp: Date.now() });
  salvarIdempotencyEmDisco();
}

// =============================================================================
// Adaptador outbound — entrega mensagens pela API Meta
// =============================================================================

const apiMetaOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: META_TEXT_LIMIT,

  // Valida que o destinatário é um número E.164 válido.
  resolveTarget: ({ to }) => {
    const normalized = to ? normalizeE164(to.trim()) : "";
    if (!normalized) {
      return {
        ok: false,
        error: new Error("Canal api-meta: número E.164 obrigatório (ex: +5511999999999)"),
      };
    }
    return { ok: true, to: normalized };
  },

  // Entrega payload com possível template via channelData.
  // Chamado pelo delivery system quando payload.channelData existe.
  // Se channelData["api-meta"].template presente → enviarTemplateCloudApi.
  // Se não → fallback para texto/mídia normal.
  sendPayload: async (ctx: ChannelOutboundPayloadContext) => {
    const { cfg, to, payload } = ctx;
    const metaCfg = obterConfigMetaObrigatoria(cfg);

    // Idempotência — se o n8n retentou por timeout, não reenvia
    const idempotencyKey = extrairIdempotencyKey(payload.channelData);
    if (idempotencyKey) {
      const cached = verificarIdempotency(idempotencyKey);
      if (cached) {
        log.info(`Idempotência: chave '${idempotencyKey}' já processada para ${to} — retornando messageId original`);
        return { channel: cached.channel, messageId: cached.messageId };
      }
    }

    // Verifica se há template no channelData
    const template = extrairTemplate(payload.channelData);
    if (template) {
      const result = await comRetry<{ messageId: string }>(
        () => enviarTemplateCloudApi(metaCfg, to, template),
        `enviarTemplate '${template.name}' para ${to}`,
      );

      // Espelha template no Chatwoot com variáveis para contexto do atendente
      const varsResumo = template.variables?.length
        ? ` | vars: ${template.variables.join(", ")}`
        : "";
      espelharSeguro(cfg, to, `[Template: ${template.name}${varsResumo}]`);

      log.info(`Template '${template.name}' enviado para ${to} (messageId: ${result.messageId})`);
      const deliveryResult = { channel: "api-meta", messageId: result.messageId };
      if (idempotencyKey) { registrarIdempotency(idempotencyKey, deliveryResult); }
      return deliveryResult;
    }

    // Sem template → delega para lógica normal de texto/mídia.
    // O delivery system só chama sendPayload quando channelData existe,
    // mas channelData pode ter outros campos além de template.
    const safeText = (payload.text ?? "").trim();

    if (payload.mediaUrl) {
      const result = await comRetry<{ messageId: string }>(
        () => enviarMidiaCloudApi(metaCfg, to, {
          mediaUrl: payload.mediaUrl!,
          caption: safeText || undefined,
        } as never),
        `enviarMidia para ${to}`,
      );
      if (safeText) { espelharSeguro(cfg, to, safeText); }
      log.info(`Mídia enviada para ${to} (messageId: ${result.messageId})`);
      const deliveryResult = { channel: "api-meta", messageId: result.messageId };
      if (idempotencyKey) { registrarIdempotency(idempotencyKey, deliveryResult); }
      return deliveryResult;
    }

    if (!safeText) {
      throw new Error("Canal api-meta: sem template, sem mídia e sem texto — nada a enviar.");
    }

    const result = await comRetry<{ messageId: string }>(
      () => enviarTextoCloudApi(metaCfg, to, safeText),
      `enviarTexto para ${to}`,
    );
    espelharSeguro(cfg, to, safeText);
    log.info(`Texto enviado para ${to} (messageId: ${result.messageId})`);
    const deliveryResult = { channel: "api-meta", messageId: result.messageId };
    if (idempotencyKey) { registrarIdempotency(idempotencyKey, deliveryResult); }
    return deliveryResult;
  },

  // Envia texto via Graph API + espelha no Chatwoot.
  // Chamado quando não há channelData no payload (texto puro).
  sendText: async ({ cfg, to, text }) => {
    const safeText = (text ?? "").trim();
    if (!safeText) {
      throw new Error("Canal api-meta: texto vazio — nada a enviar.");
    }
    const metaCfg = obterConfigMetaObrigatoria(cfg);

    const result = await comRetry<{ messageId: string }>(
      () => enviarTextoCloudApi(metaCfg, to, safeText),
      `enviarTexto para ${to}`,
    );

    espelharSeguro(cfg, to, safeText);

    log.info(`Texto enviado para ${to} (messageId: ${result.messageId})`);
    return { channel: "api-meta", messageId: result.messageId };
  },

  // Envia mídia via Graph API + espelha no Chatwoot.
  // enviarMidiaCloudApi detecta tipo automaticamente via { mediaUrl } (imagem, áudio, vídeo, documento).
  sendMedia: async ({ cfg, to, text, mediaUrl }: ChannelOutboundContext) => {
    const safeText = (text ?? "").trim();
    const metaCfg = obterConfigMetaObrigatoria(cfg);

    if (mediaUrl) {
      // Passa como { mediaUrl } — enviarMidiaCloudApi detecta tipo pela extensão da URL
      const result = await comRetry<{ messageId: string }>(
        () => enviarMidiaCloudApi(metaCfg, to, { mediaUrl, caption: safeText || undefined } as never),
        `enviarMidia para ${to}`,
      );

      if (safeText) {
        espelharSeguro(cfg, to, safeText);
      }

      log.info(`Mídia enviada para ${to} (messageId: ${result.messageId})`);
      return { channel: "api-meta", messageId: result.messageId };
    }

    // Sem mídia → envia como texto (se houver)
    if (!safeText) {
      throw new Error("Canal api-meta: sem mídia e sem texto — nada a enviar.");
    }

    const result = await comRetry<{ messageId: string }>(
      () => enviarTextoCloudApi(metaCfg, to, safeText),
      `enviarTexto (fallback) para ${to}`,
    );

    espelharSeguro(cfg, to, safeText);

    log.info(`Texto (sem mídia) enviado para ${to} (messageId: ${result.messageId})`);
    return { channel: "api-meta", messageId: result.messageId };
  },
};

// =============================================================================
// Plugin de canal — registra "api-meta" no OpenClaw
// =============================================================================

const apiMetaPlugin: ChannelPlugin = {
  id: "api-meta",
  meta: {
    id: "api-meta",
    label: "API Meta",
    selectionLabel: "API Meta (WhatsApp Business — Neurotrading Suporte)",
    docsPath: "/channels/api-meta",
    blurb: "Entrega de mensagens via API Meta (Graph API) para campanhas. Número 97868-1404.",
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ accountId: "default", enabled: true }),
    isEnabled: () => true,
    // Assinatura real do SDK: isConfigured(account, cfg).
    // Verifica se integrations.metaCloudApi está realmente configurada.
    // Sem isso, o canal "parece ok" mas explode no envio — dificulta debug.
    isConfigured: (_account: ChannelAccountSnapshot, cfg: OpenClawConfig) => {
      try {
        obterConfigMetaObrigatoria(cfg);
        return true;
      } catch {
        return false;
      }
    },
  },
  outbound: apiMetaOutbound,
};

// =============================================================================
// Endpoint HTTP — /hooks/api-meta/template
// =============================================================================
// Permite que o n8n envie templates diretamente, sem passar pelo agente LLM.
// Isso resolve o problema de sendPayload nunca ser chamado no fluxo hooks/agent,
// porque o POST /hooks/agent não suporta channelData.
//
// Uso pelo n8n:
//   POST http://localhost:18789/hooks/api-meta/template
//   Authorization: Bearer <hooks.token>
//   Content-Type: application/json
//   {
//     "to": "+5511999999999",
//     "template": { "name": "prospeccao_fellipe_v1", "language": "pt_BR", "variables": ["João"] },
//     "idempotencyKey": "campanha-2026-02:+5511999999999"   // opcional
//   }
// =============================================================================

/** Limite do body do POST (64KB — templates são pequenos). */
const TEMPLATE_ENDPOINT_MAX_BODY = 64 * 1024;

/**
 * Lê o body JSON de um IncomingMessage.
 * Retorna { ok, value } ou { ok: false, error }.
 */
function lerJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: `Body excede ${maxBytes} bytes` });
      } else {
        chunks.push(chunk);
      }
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve({ ok: true, value: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, error: "JSON inválido no body" });
      }
    });

    req.on("error", (err) => {
      resolve({ ok: false, error: `Erro lendo body: ${err.message}` });
    });
  });
}

/**
 * Extrai Bearer token do header Authorization.
 */
function extrairBearerToken(req: IncomingMessage): string | undefined {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization.trim() : "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  // Fallback: header custom do OpenClaw
  const headerToken = req.headers["x-openclaw-token"];
  if (typeof headerToken === "string" && headerToken.length > 0) {
    return headerToken;
  }
  return undefined;
}

/** Schema esperado no body do POST /hooks/api-meta/template */
type TemplateEndpointBody = {
  to: string;
  template: TemplateParams;
  idempotencyKey?: string;
};

/**
 * Handler do endpoint /hooks/api-meta/template.
 * Valida auth, parseia body, envia template, espelha no Chatwoot.
 */
async function handleTemplateEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig,
): Promise<void> {
  // Só aceita POST
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end(JSON.stringify({ error: "Método não permitido — use POST" }));
    return;
  }

  // Validar token
  const hookToken = (cfg as Record<string, unknown> & { hooks?: { token?: string } }).hooks?.token?.trim();
  if (!hookToken) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "hooks.token não configurado no openclaw.json" }));
    return;
  }
  const token = extrairBearerToken(req);
  if (token !== hookToken) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Token inválido ou ausente" }));
    return;
  }

  // Ler body
  const bodyResult = await lerJsonBody(req, TEMPLATE_ENDPOINT_MAX_BODY);
  if (!bodyResult.ok) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: bodyResult.error }));
    return;
  }

  const body = bodyResult.value as Partial<TemplateEndpointBody>;

  // Validar campos obrigatórios
  if (!body.to || typeof body.to !== "string") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Campo 'to' obrigatório (número E.164)" }));
    return;
  }
  if (!body.template || typeof body.template !== "object") {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Campo 'template' obrigatório (objeto com name, language)" }));
    return;
  }
  if (!body.template.name || !body.template.language) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Template precisa de 'name' e 'language'" }));
    return;
  }

  // Normalizar destinatário
  const to = normalizeE164(body.to.trim());
  if (!to) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: `Número inválido: ${body.to}` }));
    return;
  }

  // Config do Meta
  let metaCfg: MetaCloudApiConfig;
  try {
    metaCfg = obterConfigMetaObrigatoria(cfg);
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  // Idempotência
  const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 0
    ? body.idempotencyKey
    : undefined;

  if (idempotencyKey) {
    const cached = verificarIdempotency(idempotencyKey);
    if (cached) {
      log.info(`[template-endpoint] Idempotência: chave '${idempotencyKey}' já processada para ${to}`);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        messageId: cached.messageId,
        deduplicated: true,
      }));
      return;
    }
  }

  // Enviar template
  try {
    const result = await comRetry<{ messageId: string }>(
      () => enviarTemplateCloudApi(metaCfg, to, body.template!),
      `[template-endpoint] enviarTemplate '${body.template.name}' para ${to}`,
    );

    // Registrar idempotência
    if (idempotencyKey) {
      registrarIdempotency(idempotencyKey, { channel: "api-meta", messageId: result.messageId });
    }

    // Espelhar no Chatwoot
    const varsResumo = body.template.variables?.length
      ? ` | vars: ${body.template.variables.join(", ")}`
      : "";
    espelharSeguro(cfg, to, `[Template: ${body.template.name}${varsResumo}]`);

    log.info(`[template-endpoint] Template '${body.template.name}' enviado para ${to} (messageId: ${result.messageId})`);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      messageId: result.messageId,
    }));
  } catch (err) {
    log.error(`[template-endpoint] Falha ao enviar template para ${to}: ${err instanceof Error ? err.message : String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

// =============================================================================
// Registro do plugin
// =============================================================================

const plugin = {
  id: "neurotrading-api-meta",
  name: "Neurotrading API Meta",
  description:
    "Canal de entrega via API Meta (Graph API do Facebook). " +
    "Usado para campanhas de prospecção pelo número 97868-1404 (Neurotrading Suporte).",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // Captura o logger do OpenClaw para uso em todo o módulo
    log = api.logger;

    // Inicializar idempotência persistente
    // Usa o diretório de estado do runtime (~/.openclaw/) para persistir
    const stateDir = api.runtime?.stateDir;
    if (stateDir) {
      idempotencyFilePath = path.join(stateDir, "api-meta-idempotency.json");
      carregarIdempotencyDoDisco();
      log.info(`Idempotência persistente: ${idempotencyFilePath} (${idempotencyCache.size} chaves carregadas)`);
    } else {
      log.warn("stateDir não disponível — idempotência será apenas em memória (perdida no restart)");
    }

    // Registrar canal de entrega
    api.registerChannel({ plugin: apiMetaPlugin });

    // Registrar endpoint HTTP para envio direto de templates
    // Rota: POST /hooks/api-meta/template
    const cfg = api.config;
    api.registerHttpRoute({
      path: "/hooks/api-meta/template",
      handler: (req: IncomingMessage, res: ServerResponse) => handleTemplateEndpoint(req, res, cfg),
    });
    log.info("Endpoint HTTP registrado: POST /hooks/api-meta/template");
  },
};

export default plugin;
