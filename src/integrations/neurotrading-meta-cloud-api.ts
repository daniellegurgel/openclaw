/**
 * =============================================================================
 * INTEGRAÇÃO META CLOUD API — Webhook inbound para campanhas de prospecção
 * =============================================================================
 *
 * Autora: Danielle Gurgel
 * Criado em: 2026-02-24
 *
 * -----------------------------------------------------------------------------
 * CONTEXTO DE NEGÓCIO
 * -----------------------------------------------------------------------------
 * A Neurotrading usa dois números de WhatsApp:
 *   - 91558-2223 → WhatsApp Web (Baileys) — atendimento diário
 *   - 97868-1404 → Meta Cloud API — campanhas de prospecção outbound
 *
 * Para campanhas, o fluxo é:
 *   1. n8n cria sessão no Fellipe (agente IA) com contexto da campanha
 *   2. n8n envia template `abertura_fellipe` via Cloud API → lead recebe
 *   3. Lead responde → Meta envia webhook POST → este módulo processa
 *   4. Fellipe já tem a sessão com contexto → gera resposta → enviada via Cloud API
 *
 * Este módulo contém as funções puras (parse, verify, send) da integração.
 * O handler HTTP fica em `src/gateway/neurotrading-hooks-meta-whatsapp.ts`.
 *
 * -----------------------------------------------------------------------------
 * CONTEXTO TÉCNICO
 * -----------------------------------------------------------------------------
 * - Segue o padrão de `ponte-chatwoot.ts`: fire-and-forget, timeout, warn-only.
 * - Usa Graph API v21.0 para envio de mensagens.
 * - Validação HMAC-SHA256 do payload (X-Hub-Signature-256).
 * - Normalização de wa_id (sem "+") vs E.164 (com "+") para filtro de eco.
 * - accountId: "default" para casar com bindings existentes.
 *
 * Configuração via openclaw.json:
 *   integrations.metaCloudApi.enabled       : true
 *   integrations.metaCloudApi.phoneNumberId  : "1066019119918807"
 *   integrations.metaCloudApi.accessToken    : "<system user token>"
 *   integrations.metaCloudApi.appSecret      : "<app secret>"
 *   integrations.metaCloudApi.verifyToken    : "<verify token arbitrário>"
 *   integrations.metaCloudApi.selfNumber     : "+5511978681404"
 *
 * =============================================================================
 */

import type { AnyMessageContent } from "@whiskeysockets/baileys";
import crypto from "node:crypto";
import type { WebInboundMessage } from "../web/inbound/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeE164 } from "../utils.js";

const log = createSubsystemLogger("meta-cloud-api");

// =============================================================================
// Tipo de configuração (vai no openclaw.json → integrations.metaCloudApi)
// =============================================================================

export type MetaCloudApiConfig = {
  enabled?: boolean;
  phoneNumberId?: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  selfNumber?: string;
};

// =============================================================================
// Tipo interno: mensagem extraída do webhook
// =============================================================================

export type MensagemCloudApi = {
  /** wa_id do remetente (sem "+", ex: "5511999999999") */
  waId: string;
  /** Texto da mensagem */
  texto: string;
  /** Nome de exibição do remetente (pushName) */
  nome?: string;
  /** ID da mensagem no Cloud API (wamid.*) */
  messageId?: string;
  /** Timestamp Unix (segundos) */
  timestamp?: number;
};

// =============================================================================
// Verificação do challenge GET do Meta
// =============================================================================

/**
 * Verifica o challenge de validação do webhook (GET).
 * O Meta envia hub.mode, hub.verify_token e hub.challenge como query params.
 * Se o verify_token bater, retorna o challenge para confirmar a inscrição.
 */
export function verificarChallengeWebhook(
  url: URL,
  verifyToken: string,
): { ok: true; challenge: string } | { ok: false; status: number; error: string } {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe") {
    return { ok: false, status: 400, error: "hub.mode deve ser 'subscribe'" };
  }
  if (!token || token !== verifyToken) {
    return { ok: false, status: 403, error: "verify_token inválido" };
  }
  if (!challenge) {
    return { ok: false, status: 400, error: "hub.challenge ausente" };
  }
  return { ok: true, challenge };
}

// =============================================================================
// Validação HMAC-SHA256 do payload
// =============================================================================

/**
 * Valida a assinatura HMAC-SHA256 do webhook.
 * IMPORTANTE: rawBody deve ser o Buffer original, ANTES de qualquer JSON.parse.
 * O header X-Hub-Signature-256 tem formato "sha256=<hex>".
 */
export function validarAssinaturaWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = signatureHeader.slice("sha256=".length);
  const computed = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  // Comparação segura contra timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(computed, "hex"));
  } catch {
    // Se os tamanhos forem diferentes, timingSafeEqual lança — assinatura inválida
    return false;
  }
}

// =============================================================================
// Parser do webhook — extrai mensagens, ignora status updates
// =============================================================================

/**
 * Normaliza wa_id e selfNumber para formato comparável (só dígitos, sem "+").
 * Cloud API envia wa_id como "5511999999999" (sem "+").
 * selfNumber pode estar como "+5511978681404" (com "+").
 */
function normalizarParaComparacao(telefone: string): string {
  return telefone.replace(/\D/g, "");
}

/**
 * Extrai mensagens do payload do webhook da Meta Cloud API.
 * Itera entry[].changes[].value.messages[], filtra eco (from === selfNumber),
 * ignora statuses[].
 */
export function extrairMensagensDoWebhook(
  payload: Record<string, unknown>,
  selfNumber?: string,
): MensagemCloudApi[] {
  const mensagens: MensagemCloudApi[] = [];
  const selfNormalizado = selfNumber ? normalizarParaComparacao(selfNumber) : null;

  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as unknown[])
      : [];

    for (const change of changes) {
      if (!change || typeof change !== "object") {
        continue;
      }
      const value = (change as Record<string, unknown>).value;
      if (!value || typeof value !== "object") {
        continue;
      }

      const messages = Array.isArray((value as Record<string, unknown>).messages)
        ? ((value as Record<string, unknown>).messages as unknown[])
        : [];

      // Mapear contacts por wa_id para evitar O(n*m) no loop de mensagens
      const contactMap = new Map<string, string>();
      const contacts = Array.isArray((value as Record<string, unknown>).contacts)
        ? ((value as Record<string, unknown>).contacts as unknown[])
        : [];
      for (const contact of contacts) {
        if (!contact || typeof contact !== "object") {
          continue;
        }
        const c = contact as Record<string, unknown>;
        const cWaId = typeof c.wa_id === "string" ? c.wa_id : "";
        if (cWaId && c.profile && typeof c.profile === "object") {
          const profile = c.profile as Record<string, unknown>;
          if (typeof profile.name === "string") {
            contactMap.set(cWaId, profile.name);
          }
        }
      }

      for (const msg of messages) {
        if (!msg || typeof msg !== "object") {
          continue;
        }
        const m = msg as Record<string, unknown>;

        const waId = typeof m.from === "string" ? m.from.trim() : "";
        if (!waId) {
          continue;
        }

        // Filtro de eco: ignora mensagens do próprio número
        if (selfNormalizado && normalizarParaComparacao(waId) === selfNormalizado) {
          log.debug(`Ignorando mensagem de eco (from=${waId})`);
          continue;
        }

        // Extrair texto — suporta mensagens de texto simples
        let texto = "";
        if (m.type === "text" && m.text && typeof m.text === "object") {
          texto =
            typeof (m.text as Record<string, unknown>).body === "string"
              ? ((m.text as Record<string, unknown>).body as string)
              : "";
        } else if (m.type === "button" && m.button && typeof m.button === "object") {
          // Resposta a botão (ex: Quick Reply do template)
          texto =
            typeof (m.button as Record<string, unknown>).text === "string"
              ? ((m.button as Record<string, unknown>).text as string)
              : "";
        } else if (m.type === "interactive" && m.interactive && typeof m.interactive === "object") {
          // Resposta a lista interativa ou botão de resposta
          const interactive = m.interactive as Record<string, unknown>;
          if (
            interactive.type === "button_reply" &&
            interactive.button_reply &&
            typeof interactive.button_reply === "object"
          ) {
            texto =
              typeof (interactive.button_reply as Record<string, unknown>).title === "string"
                ? ((interactive.button_reply as Record<string, unknown>).title as string)
                : "";
          } else if (
            interactive.type === "list_reply" &&
            interactive.list_reply &&
            typeof interactive.list_reply === "object"
          ) {
            texto =
              typeof (interactive.list_reply as Record<string, unknown>).title === "string"
                ? ((interactive.list_reply as Record<string, unknown>).title as string)
                : "";
          }
        }

        if (!texto) {
          // Tipos não suportados por enquanto (image, video, audio, document, location, contacts)
          log.debug(`Mensagem ignorada: tipo '${String(m.type)}' de ${waId} (sem texto extraível)`);
          continue;
        }

        // Nome do remetente (via contactMap pré-computado — O(1) em vez de O(n))
        const nome = contactMap.get(waId);

        // Cloud API envia timestamp como string de segundos Unix.
        // Convertemos para milissegundos (padrão do OpenClaw — ver monitor.ts:198-199).
        const timestampSec =
          typeof m.timestamp === "string" ? parseInt(m.timestamp, 10) : undefined;
        const timestampMs = timestampSec && !isNaN(timestampSec) ? timestampSec * 1000 : undefined;

        mensagens.push({
          waId,
          texto,
          nome,
          messageId: typeof m.id === "string" ? m.id : undefined,
          timestamp: timestampMs,
        });
      }
    }
  }

  return mensagens;
}

// =============================================================================
// Envio de texto via Graph API
// =============================================================================

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";
const GRAPH_API_TIMEOUT_MS = 10_000;

/**
 * Envia uma mensagem de texto via Graph API do Meta.
 * Timeout de 10s para evitar acúmulo de Promises.
 */
export async function enviarTextoCloudApi(
  config: MetaCloudApiConfig,
  destinatario: string,
  texto: string,
): Promise<{ messageId: string }> {
  const phoneNumberId = config.phoneNumberId;
  const accessToken = config.accessToken;
  if (!phoneNumberId || !accessToken) {
    throw new Error("Meta Cloud API: phoneNumberId ou accessToken não configurado");
  }

  // Normalizar destinatário: Graph API espera só dígitos (sem "+")
  const to = destinatario.replace(/\D/g, "");
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: texto },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Graph API ${res.status}: ${body}`);
    }

    let messageId = "unknown";
    try {
      const data = (await res.json()) as { messages?: Array<{ id?: string }> };
      messageId = data.messages?.[0]?.id ?? "unknown";
    } catch {
      // Parse do JSON falhou mas a requisição foi 2xx — mensagem provavelmente enviada
      log.warn(`Resposta 2xx da Graph API mas JSON inválido (to=${to})`);
    }
    log.info(`Mensagem enviada via Cloud API para ${to} (id: ${messageId})`);
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extrai link de mídia de um campo do payload Baileys.
 * Aceita { url: "..." } (Baileys) ou string direta.
 */
function extrairLinkMidia(campo: unknown): string | undefined {
  if (typeof campo === "string") {
    return campo;
  }
  if (campo && typeof campo === "object") {
    const obj = campo as Record<string, unknown>;
    if (typeof obj.url === "string") {
      return obj.url;
    }
    if (typeof obj.link === "string") {
      return obj.link;
    }
  }
  return undefined;
}

/**
 * Detecta tipo de mídia pela extensão da URL.
 * Retorna "image", "audio", "video" ou "document".
 */
function detectarTipoMidia(url: string): "image" | "audio" | "video" | "document" {
  const lower = url.toLowerCase().split("?")[0] ?? "";
  if (/\.(jpe?g|png|webp|gif)$/.test(lower)) {
    return "image";
  }
  if (/\.(mp3|ogg|opus|m4a|aac|amr|wav)$/.test(lower)) {
    return "audio";
  }
  if (/\.(mp4|3gp|avi|mov|mkv|webm)$/.test(lower)) {
    return "video";
  }
  return "document";
}

/**
 * Envia mídia via Graph API do Meta.
 *
 * Suporta imagem, áudio, vídeo e documento via URL.
 * Detecta o tipo de mídia pela extensão da URL ou pela estrutura do payload.
 * Se não conseguir extrair mídia, faz fallback para texto.
 *
 * Formato do payload (estilo Baileys):
 *   { image: { url }, caption? }   → imagem
 *   { audio: { url } }             → áudio
 *   { video: { url }, caption? }   → vídeo
 *   { document: { url }, fileName?, caption? } → documento
 *
 * Ou formato direto da extensão:
 *   { mediaUrl: "https://...", caption? } → detecta pelo URL
 */
export async function enviarMidiaCloudApi(
  config: MetaCloudApiConfig,
  destinatario: string,
  payload: AnyMessageContent,
): Promise<{ messageId: string }> {
  const phoneNumberId = config.phoneNumberId;
  const accessToken = config.accessToken;
  if (!phoneNumberId || !accessToken) {
    throw new Error("Meta Cloud API: phoneNumberId ou accessToken não configurado");
  }

  const to = destinatario.replace(/\D/g, "");
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  const p = payload as Record<string, unknown>;
  const caption = typeof p.caption === "string" ? p.caption : undefined;
  let mediaBody: Record<string, unknown> | null = null;

  // 1. Imagem (formato Baileys: { image: { url }, caption? })
  const imgLink = extrairLinkMidia(p.image);
  if (imgLink) {
    mediaBody = {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imgLink, ...(caption ? { caption } : {}) },
    };
  }

  // 2. Áudio (formato Baileys: { audio: { url } })
  if (!mediaBody) {
    const audioLink = extrairLinkMidia(p.audio);
    if (audioLink) {
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "audio",
        audio: { link: audioLink },
      };
    }
  }

  // 3. Vídeo (formato Baileys: { video: { url }, caption? })
  if (!mediaBody) {
    const videoLink = extrairLinkMidia(p.video);
    if (videoLink) {
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "video",
        video: { link: videoLink, ...(caption ? { caption } : {}) },
      };
    }
  }

  // 4. Documento (formato Baileys: { document: { url }, fileName?, caption? })
  if (!mediaBody) {
    const docLink = extrairLinkMidia(p.document);
    if (docLink) {
      const fileName = typeof p.fileName === "string" ? p.fileName : undefined;
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: {
          link: docLink,
          ...(caption ? { caption } : {}),
          ...(fileName ? { filename: fileName } : {}),
        },
      };
    }
  }

  // 5. Formato direto: { mediaUrl: "https://..." } — detecta tipo pela extensão
  if (!mediaBody && typeof p.mediaUrl === "string") {
    const tipo = detectarTipoMidia(p.mediaUrl);
    const link = p.mediaUrl;
    if (tipo === "image") {
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "image",
        image: { link, ...(caption ? { caption } : {}) },
      };
    } else if (tipo === "audio") {
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "audio",
        audio: { link },
      };
    } else if (tipo === "video") {
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "video",
        video: { link, ...(caption ? { caption } : {}) },
      };
    } else {
      mediaBody = {
        messaging_product: "whatsapp",
        to,
        type: "document",
        document: { link, ...(caption ? { caption } : {}) },
      };
    }
  }

  // Fallback: se não conseguiu extrair mídia, envia caption como texto
  if (!mediaBody) {
    if (caption) {
      log.warn(`Mídia não reconhecida para ${to}, enviando caption como texto`);
      return enviarTextoCloudApi(config, destinatario, caption);
    }
    log.warn(`Mídia não suportada para Cloud API (to=${to}), descartando payload`);
    return { messageId: "unsupported-media" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(mediaBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Graph API media ${res.status}: ${body}`);
    }

    let messageId = "unknown";
    try {
      const data = (await res.json()) as { messages?: Array<{ id?: string }> };
      messageId = data.messages?.[0]?.id ?? "unknown";
    } catch {
      log.warn(`Resposta 2xx da Graph API (media) mas JSON inválido (to=${to})`);
    }
    log.info(`Mídia enviada via Cloud API para ${to} (id: ${messageId})`);
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Envio de template via Graph API (leads frios — fora da janela de 24h)
// =============================================================================

/**
 * Parâmetros para envio de template aprovado pelo Meta.
 *
 * POR QUE TEMPLATES:
 * A API Meta exige template aprovado para a primeira mensagem a um lead que
 * não interagiu nas últimas 24h (lead frio). Texto livre (type: "text") é
 * rejeitado com erro 131047.
 *
 * QUEM USA:
 *   - Extensão api-meta (agente envia primeiro toque como template)
 *   - n8n (workflow de campanha envia template direto, sem passar pelo agente)
 *
 * VARIÁVEIS:
 * O array `variables` mapeia para {{1}}, {{2}}, {{3}} no corpo do template.
 * A ordem importa — {{1}} = variables[0], {{2}} = variables[1], etc.
 *
 * HEADER COM IMAGEM (opcional):
 * Se `headerImageUrl` for informado, o template precisa ter um header do tipo
 * IMAGE no Meta Business Manager. A URL deve ser HTTPS e acessível publicamente.
 */
export type TemplateParams = {
  /** Nome do template aprovado no Meta Business Manager (ex: "prospeccao_fellipe_v1") */
  name: string;
  /** Código do idioma (ex: "pt_BR") */
  language: string;
  /** Variáveis do corpo — {{1}}, {{2}}, etc. (ordem importa) */
  variables?: string[];
  /** URL de imagem para header do tipo IMAGE (opcional, deve ser HTTPS público) */
  headerImageUrl?: string;
};

/**
 * Envia uma mensagem de template aprovado via Graph API do Meta.
 *
 * Templates são obrigatórios para leads frios (fora da janela de 24h).
 * Após o lead responder, a janela abre e o agente pode usar texto livre.
 *
 * Retorna o messageId do Meta (wamid.*).
 * Lança erro com o código do Meta se o template não existir ou estiver rejeitado.
 */
export async function enviarTemplateCloudApi(
  config: MetaCloudApiConfig,
  destinatario: string,
  template: TemplateParams,
): Promise<{ messageId: string }> {
  const phoneNumberId = config.phoneNumberId;
  const accessToken = config.accessToken;
  if (!phoneNumberId || !accessToken) {
    throw new Error("Meta Cloud API: phoneNumberId ou accessToken não configurado");
  }

  // Normalizar destinatário: Graph API espera só dígitos (sem "+")
  const to = destinatario.replace(/\D/g, "");
  const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

  // Montar components do template
  const components: Array<Record<string, unknown>> = [];

  // Header com imagem (opcional)
  if (template.headerImageUrl) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { link: template.headerImageUrl } }],
    });
  }

  // Variáveis do corpo ({{1}}, {{2}}, ...)
  if (template.variables && template.variables.length > 0) {
    components.push({
      type: "body",
      parameters: template.variables.map((v) => ({ type: "text", text: v })),
    });
  }

  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPH_API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const resBody = await res.text().catch(() => "");
      throw new Error(`Graph API template ${res.status}: ${resBody}`);
    }

    let messageId = "unknown";
    try {
      const data = (await res.json()) as { messages?: Array<{ id?: string }> };
      messageId = data.messages?.[0]?.id ?? "unknown";
    } catch {
      log.warn(`Resposta 2xx da Graph API (template) mas JSON inválido (to=${to})`);
    }
    log.info(`Template '${template.name}' enviado via Cloud API para ${to} (id: ${messageId})`);
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// Construção da WebInboundMessage sintética
// =============================================================================

/**
 * Constrói uma WebInboundMessage sintética a partir de uma mensagem do Cloud API.
 *
 * Decisões técnicas validadas:
 * - id: undefined → evita que maybeSendAckReaction tente enviar reação via Baileys
 * - accountId: "default" → casa com bindings existentes (validado: matchesAccountId)
 * - reply/sendMedia: apontam para Graph API (não Baileys)
 * - sendComposing: noop (Cloud API não suporta "digitando" para bots)
 */
export function construirMensagemSintetica(
  mensagem: MensagemCloudApi,
  config: MetaCloudApiConfig,
): WebInboundMessage {
  if (!config.selfNumber) {
    throw new Error(
      "Meta Cloud API: selfNumber não configurado — impossível construir mensagem sintética",
    );
  }
  const senderE164 = normalizeE164(mensagem.waId);

  return {
    // id: undefined → pula maybeSendAckReaction (que tentaria Baileys)
    id: undefined,
    from: senderE164,
    conversationId: senderE164,
    to: config.selfNumber,
    accountId: "default",
    body: mensagem.texto,
    pushName: mensagem.nome,
    timestamp: mensagem.timestamp,
    chatType: "direct",
    chatId: senderE164,
    senderE164,
    senderName: mensagem.nome,
    selfJid: null,
    selfE164: config.selfNumber,

    // Callbacks que apontam para Graph API (não Baileys)
    sendComposing: async () => {
      // Cloud API não suporta indicador de "digitando" para bots — noop
    },
    reply: async (text: string) => {
      try {
        await enviarTextoCloudApi(config, senderE164, text);
      } catch (err) {
        log.error(`Falha ao enviar resposta Cloud API para ${senderE164}: ${err}`);
        throw err;
      }
    },
    sendMedia: async (payload: AnyMessageContent) => {
      try {
        await enviarMidiaCloudApi(config, senderE164, payload);
      } catch (err) {
        log.error(`Falha ao enviar mídia Cloud API para ${senderE164}: ${err}`);
        throw err;
      }
    },
  };
}
