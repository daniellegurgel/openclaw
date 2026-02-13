/**
 * /handoff command handler.
 *
 * Commands:
 *   /handoff on  +55XXXXXXXXXXX [minutes]   — pause bot for that number
 *   /handoff off +55XXXXXXXXXXX             — resume bot for that number
 *   /handoff list                            — show all active handoffs
 */

import type { CommandHandler } from "./commands-types.js";
import {
  activateHandoff,
  deactivateHandoff,
  listActiveHandoffs,
} from "../../sessions/handoff-store.js";
import { normalizeE164 } from "../../utils.js";

const DEFAULT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseHandoffCommand(body: string): {
  hasCommand: boolean;
  action?: "on" | "off" | "list";
  number?: string;
  minutes?: number;
} {
  const match = body.match(/^\/handoff(?:\s+(.*))?$/i);
  if (!match) return { hasCommand: false };

  const args = (match[1] ?? "").trim();
  if (!args) return { hasCommand: true }; // no action → show usage

  const parts = args.split(/\s+/);
  const action = parts[0]?.toLowerCase();

  if (action === "list") {
    return { hasCommand: true, action: "list" };
  }

  if (action === "on" || action === "off") {
    const number = parts[1];
    const minutesRaw = parts[2];
    const minutes = minutesRaw ? parseInt(minutesRaw, 10) : undefined;
    return {
      hasCommand: true,
      action,
      number: number || undefined,
      minutes: minutes && Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
    };
  }

  return { hasCommand: true }; // unknown action → show usage
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handleHandoffCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) return null;

  const parsed = parseHandoffCommand(params.command.commandBodyNormalized);
  if (!parsed.hasCommand) return null;

  // Only authorized senders may use /handoff.
  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  // If adminNumbers is configured, restrict to those numbers only.
  const adminNumbers = params.cfg.handoff?.adminNumbers;
  if (adminNumbers && adminNumbers.length > 0) {
    const senderE164 = params.ctx.SenderE164?.trim();
    const allowed = senderE164 && adminNumbers.map((n) => normalizeE164(n)).includes(normalizeE164(senderE164));
    if (!allowed) {
      return { shouldContinue: false };
    }
  }

  // No action or unrecognized action → usage hint.
  if (!parsed.action) {
    return {
      shouldContinue: false,
      reply: { text: "Uso: /handoff on +55... [minutos] | /handoff off +55... | /handoff list" },
    };
  }

  // ---- /handoff list ----
  if (parsed.action === "list") {
    const active = listActiveHandoffs();
    if (active.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "Nenhum handoff ativo." },
      };
    }
    const lines = active.map((e) => {
      const remaining = Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 60000));
      return `${e.number} — ${remaining}min restantes (por ${e.activatedBy})`;
    });
    return {
      shouldContinue: false,
      reply: { text: `Handoffs ativos:\n${lines.join("\n")}` },
    };
  }

  // ---- /handoff on ----
  if (parsed.action === "on") {
    if (!parsed.number) {
      return {
        shouldContinue: false,
        reply: { text: "Uso: /handoff on +55XXXXXXXXXXX [minutos]" },
      };
    }
    const defaultMinutes = params.cfg.handoff?.defaultMinutes ?? DEFAULT_MINUTES;
    const minutes = parsed.minutes ?? defaultMinutes;
    const normalized = normalizeE164(parsed.number);
    const activatedBy = params.ctx.SenderE164 || params.command.senderId || "admin";

    await activateHandoff(normalized, activatedBy, minutes);

    return {
      shouldContinue: false,
      reply: {
        text: `Handoff ativado para ${normalized} por ${minutes} minutos. Bot pausado para este numero.`,
      },
    };
  }

  // ---- /handoff off ----
  if (parsed.action === "off") {
    if (!parsed.number) {
      return {
        shouldContinue: false,
        reply: { text: "Uso: /handoff off +55XXXXXXXXXXX" },
      };
    }
    const normalized = normalizeE164(parsed.number);
    const removed = await deactivateHandoff(normalized);
    if (removed) {
      return {
        shouldContinue: false,
        reply: { text: `Handoff desativado para ${normalized}. Bot retomado.` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Nenhum handoff ativo encontrado para ${normalized}.` },
    };
  }

  return null;
};
