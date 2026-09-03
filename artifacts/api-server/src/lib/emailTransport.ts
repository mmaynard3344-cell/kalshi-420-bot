/**
 * Email transport wrapper for daily trading reports.
 *
 * Configuration is driven entirely by environment variables — no hardcoded
 * credentials. Two transports are supported:
 *
 *   1. SendGrid SMTP relay — set SENDGRID_API_KEY.
 *      Uses smtp.sendgrid.net:587, username "apikey".
 *
 *   2. Generic SMTP — set SMTP_HOST (+ optionally SMTP_PORT, SMTP_USER,
 *      SMTP_PASS, SMTP_SECURE).
 *
 * Recipients and sender:
 *   REPORT_RECIPIENTS — comma-separated list of To addresses (required)
 *   REPORT_FROM       — sender address (default: trading-bot@shawshank.local)
 *
 * If neither transport is configured this module returns a no-op sender that
 * logs a warning and resolves without error, so the server never crashes on a
 * missing email config.
 */

import nodemailer from "nodemailer";
import { logger } from "./logger.js";

export interface EmailMessage {
  subject: string;
  text:    string;
  html:    string;
}

export interface SendResult {
  ok:       boolean;
  info?:    string;
  error?:   string;
  skipped?: boolean; // true when no transport configured
}

// ── Config resolution ─────────────────────────────────────────────────────────

function buildTransport(): nodemailer.Transporter | null {
  const sgKey   = process.env["SENDGRID_API_KEY"];
  const smtpHost = process.env["SMTP_HOST"];

  if (sgKey) {
    logger.info("emailTransport: using SendGrid SMTP relay");
    return nodemailer.createTransport({
      host:   "smtp.sendgrid.net",
      port:   587,
      secure: false,
      auth:   { user: "apikey", pass: sgKey },
    });
  }

  if (smtpHost) {
    const port   = Number(process.env["SMTP_PORT"] ?? 587);
    const secure = process.env["SMTP_SECURE"] === "true";
    const user   = process.env["SMTP_USER"];
    const pass   = process.env["SMTP_PASS"];
    logger.info({ host: smtpHost, port, secure }, "emailTransport: using SMTP");
    return nodemailer.createTransport({
      host: smtpHost,
      port,
      secure,
      ...(user && pass ? { auth: { user, pass } } : {}),
    });
  }

  return null;
}

function getRecipients(): string[] {
  const raw = process.env["REPORT_RECIPIENTS"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getFrom(): string {
  return process.env["REPORT_FROM"] ?? "Shawshank Bot <trading-bot@shawshank.local>";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send an email to all configured REPORT_RECIPIENTS.
 * Returns a SendResult; never throws.
 */
export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const transport = buildTransport();
  const recipients = getRecipients();

  if (!transport) {
    logger.warn(
      "emailTransport: no transport configured (set SENDGRID_API_KEY or SMTP_HOST) — email skipped",
    );
    return { ok: false, skipped: true, error: "No email transport configured" };
  }

  if (recipients.length === 0) {
    logger.warn(
      "emailTransport: REPORT_RECIPIENTS is empty — email skipped",
    );
    return { ok: false, skipped: true, error: "No recipients configured (REPORT_RECIPIENTS)" };
  }

  try {
    const info = await transport.sendMail({
      from:    getFrom(),
      to:      recipients.join(", "),
      subject: msg.subject,
      text:    msg.text,
      html:    msg.html,
    });

    const infoStr = String((info as { messageId?: string }).messageId ?? info);
    logger.info(
      { recipients, subject: msg.subject, messageId: infoStr },
      "emailTransport: email sent",
    );
    return { ok: true, info: infoStr };
  } catch (err) {
    const errStr = String(err);
    logger.error({ err, subject: msg.subject }, "emailTransport: send failed");
    return { ok: false, error: errStr };
  }
}
