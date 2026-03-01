/**
 * Email delivery service for sending completed ESA reports to clients.
 * Supports SMTP, Gmail (OAuth2), and SendGrid providers via nodemailer.
 */

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import pino from 'pino';
import type { EmailDeliveryConfig } from '../types/config.js';

const logger = pino({ name: 'email-delivery' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeliveryRequest {
  to: string[];
  cc?: string[];
  subject: string;
  projectName: string;
  clientName: string;
  propertyAddress: string;
  reportType: string;
  qcScore?: number;
  attachments: Array<{
    filename: string;
    path: string;
    label: string;
    sizeMB: number;
  }>;
}

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  recipients: string[];
  attachmentCount: number;
  totalSizeMB: number;
  sentAt: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Rate-limiting helper
// ---------------------------------------------------------------------------

const deliveryCounts = new Map<string, number[]>();

export function checkRateLimit(
  email: string,
  maxPerHour: number,
  maxPerDay: number,
): boolean {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const timestamps = (deliveryCounts.get(email) ?? []).filter(
    (t) => t > oneDayAgo,
  );
  deliveryCounts.set(email, timestamps);

  const lastHourCount = timestamps.filter((t) => t > oneHourAgo).length;
  if (lastHourCount >= maxPerHour) return false;
  if (timestamps.length >= maxPerDay) return false;

  return true;
}

function recordDelivery(email: string): void {
  const timestamps = deliveryCounts.get(email) ?? [];
  timestamps.push(Date.now());
  deliveryCounts.set(email, timestamps);
}

// ---------------------------------------------------------------------------
// EmailDeliveryService
// ---------------------------------------------------------------------------

export class EmailDeliveryService {
  private transporter: Transporter | null = null;
  private config: EmailDeliveryConfig;

  constructor(config: EmailDeliveryConfig) {
    this.config = config;
  }

  /** Create the nodemailer transporter and verify the connection. */
  async init(): Promise<void> {
    const transportOpts = this.buildTransportOptions();
    this.transporter = nodemailer.createTransport(transportOpts);

    try {
      await this.transporter.verify();
      logger.info(
        { provider: this.config.provider },
        'Email transporter verified',
      );
    } catch (err) {
      logger.error({ err, provider: this.config.provider }, 'Email transporter verification failed');
      throw err;
    }
  }

  /** Send an ESA report delivery email. */
  async deliver(request: DeliveryRequest): Promise<DeliveryResult> {
    if (!this.transporter) {
      return {
        success: false,
        recipients: request.to,
        attachmentCount: request.attachments.length,
        totalSizeMB: request.attachments.reduce((s, a) => s + a.sizeMB, 0),
        sentAt: new Date().toISOString(),
        error: 'Transporter not initialised — call init() first',
      };
    }

    // Rate-limit check for every recipient
    const { max_per_hour, max_per_day } = this.config.rate_limit;
    for (const addr of request.to) {
      if (!checkRateLimit(addr, max_per_hour, max_per_day)) {
        const msg = `Rate limit exceeded for ${addr}`;
        logger.warn(msg);
        return {
          success: false,
          recipients: request.to,
          attachmentCount: request.attachments.length,
          totalSizeMB: request.attachments.reduce((s, a) => s + a.sizeMB, 0),
          sentAt: new Date().toISOString(),
          error: msg,
        };
      }
    }

    const totalSizeMB = request.attachments.reduce((s, a) => s + a.sizeMB, 0);

    const cc = [
      ...(request.cc ?? []),
      ...this.config.cc_list,
    ];

    try {
      const info = await this.transporter.sendMail({
        from: `"${this.config.from_name}" <${this.config.from_email}>`,
        to: request.to.join(', '),
        cc: cc.length > 0 ? cc.join(', ') : undefined,
        bcc: this.config.bcc_list.length > 0 ? this.config.bcc_list.join(', ') : undefined,
        replyTo: this.config.reply_to,
        subject: request.subject,
        html: this.buildEmailTemplate(request),
        attachments: request.attachments.map((a) => ({
          filename: a.filename,
          path: a.path,
        })),
      });

      // Record delivery for rate-limiting
      for (const addr of request.to) {
        recordDelivery(addr);
      }

      logger.info(
        { messageId: info.messageId, to: request.to, attachments: request.attachments.length },
        'Email delivered',
      );

      return {
        success: true,
        messageId: info.messageId,
        recipients: request.to,
        attachmentCount: request.attachments.length,
        totalSizeMB,
        sentAt: new Date().toISOString(),
      };
    } catch (err: any) {
      logger.error({ err, to: request.to }, 'Email delivery failed');
      return {
        success: false,
        recipients: request.to,
        attachmentCount: request.attachments.length,
        totalSizeMB,
        sentAt: new Date().toISOString(),
        error: err?.message ?? String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildTransportOptions(): Record<string, any> {
    switch (this.config.provider) {
      case 'gmail': {
        const gmail = this.config.gmail;
        if (!gmail) throw new Error('Gmail config missing');
        return {
          service: 'gmail',
          auth: {
            type: 'OAuth2',
            user: gmail.user,
            clientId: process.env[gmail.client_id_env],
            clientSecret: process.env[gmail.client_secret_env],
            refreshToken: process.env[gmail.refresh_token_env],
          },
        };
      }

      case 'sendgrid': {
        const sg = this.config.sendgrid;
        if (!sg) throw new Error('SendGrid config missing');
        return {
          host: 'smtp.sendgrid.net',
          port: 465,
          secure: true,
          auth: {
            user: 'apikey',
            pass: process.env[sg.api_key_env],
          },
        };
      }

      case 'smtp':
      default: {
        const smtp = this.config.smtp;
        if (!smtp) throw new Error('SMTP config missing');
        return {
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: {
            user: smtp.user,
            pass: process.env[smtp.pass_env],
          },
        };
      }
    }
  }

  private buildEmailTemplate(request: DeliveryRequest): string {
    const hasMultipleParts = request.attachments.length > 1;
    const qcSection = request.qcScore != null
      ? `<tr>
           <td style="padding:8px 16px;color:#555;font-size:14px;">QC Score</td>
           <td style="padding:8px 16px;font-size:14px;font-weight:600;">${Math.round(request.qcScore * 100)}%</td>
         </tr>`
      : '';

    const splitNote = hasMultipleParts
      ? `<p style="margin:16px 0 0;padding:12px 16px;background:#fff8e1;border-left:4px solid #ffc107;font-size:13px;color:#666;">
           This report has been split into <strong>${request.attachments.length} attachments</strong> due to file size.
           Please download all parts and combine them for the complete report.
         </p>`
      : '';

    const attachmentList = request.attachments
      .map(
        (a) =>
          `<li style="padding:4px 0;font-size:13px;color:#444;">${a.label} — <em>${a.filename}</em> (${a.sizeMB.toFixed(1)} MB)</li>`,
      )
      .join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#2e7d32;padding:24px 32px;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">ODIC Environmental</h1>
            <p style="margin:4px 0 0;color:#c8e6c9;font-size:13px;">Environmental Site Assessment Report Delivery</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="margin:0 0 8px;font-size:15px;color:#333;">Dear ${request.clientName},</p>
            <p style="margin:0 0 24px;font-size:14px;color:#555;line-height:1.5;">
              Please find attached the completed <strong>${request.reportType}</strong> report for the property listed below.
            </p>

            <!-- Property card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fbe7;border:1px solid #dcedc8;border-radius:6px;margin-bottom:24px;">
              <tr>
                <td colspan="2" style="padding:12px 16px;border-bottom:1px solid #dcedc8;font-size:12px;text-transform:uppercase;color:#558b2f;font-weight:700;letter-spacing:0.5px;">
                  Property Details
                </td>
              </tr>
              <tr>
                <td style="padding:8px 16px;color:#555;font-size:14px;">Address</td>
                <td style="padding:8px 16px;font-size:14px;font-weight:600;">${request.propertyAddress}</td>
              </tr>
              <tr>
                <td style="padding:8px 16px;color:#555;font-size:14px;">Project</td>
                <td style="padding:8px 16px;font-size:14px;font-weight:600;">${request.projectName}</td>
              </tr>
              <tr>
                <td style="padding:8px 16px;color:#555;font-size:14px;">Report Type</td>
                <td style="padding:8px 16px;font-size:14px;font-weight:600;">${request.reportType}</td>
              </tr>
              ${qcSection}
            </table>

            <!-- Attachments -->
            <p style="margin:0 0 8px;font-size:14px;font-weight:600;color:#333;">Attached Files:</p>
            <ul style="margin:0 0 16px;padding-left:20px;">
              ${attachmentList}
            </ul>

            ${splitNote}

            <p style="margin:24px 0 0;font-size:14px;color:#555;line-height:1.5;">
              If you have any questions regarding this report, please do not hesitate to reply to this email or contact our office directly.
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fafafa;padding:20px 32px;border-top:1px solid #e0e0e0;">
            <p style="margin:0 0 4px;font-size:13px;color:#888;font-weight:600;">ODIC Environmental</p>
            <p style="margin:0;font-size:12px;color:#aaa;">407 West Imperial Suite H #303, Brea, CA 92821</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }
}
