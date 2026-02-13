/**
 * Configuration and state types for the handoff feature.
 *
 * Handoff allows an admin to temporarily pause bot responses for a specific
 * phone number so a human can take over the conversation on WhatsApp Web.
 */

/**
 * Config block for `openclaw.json` → `handoff`.
 */
export type HandoffConfig = {
  /** Default pause duration in minutes when not specified in the command. Default: 30 */
  defaultMinutes?: number;
  /** Message sent to the client each time they message while paused. */
  pauseMessage?: string;
  /** E.164 numbers allowed to use /handoff. When set, only these numbers can run the command. */
  adminNumbers?: string[];
};

/**
 * A single active handoff entry persisted in the state store.
 */
export type HandoffEntry = {
  /** E.164 phone number (e.g. "+5511999999999"). */
  number: string;
  /** Who activated the handoff (E.164 or identifier). */
  activatedBy: string;
  /** Activation timestamp (epoch ms). */
  activatedAt: number;
  /** Expiration timestamp (epoch ms). */
  expiresAt: number;
};

/**
 * On-disk shape of the handoff state file.
 */
export type HandoffStoreData = {
  entries: HandoffEntry[];
};
