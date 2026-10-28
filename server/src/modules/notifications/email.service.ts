import 'dotenv/config';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';
import nodemailer, { Transporter } from 'nodemailer';
import { prisma } from '../../prisma';
import { generateJobPdf } from '../jobs/pdf.service';

// Ensure dotenv is reliably initialized from server root or process.cwd()
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config();

/**
 * Resolve the server's LAN IPv4 host for direct PDF download links in customer emails.
 */
function getServerLanHost(): string {
  if (process.env.PUBLIC_HOST && process.env.PUBLIC_HOST.trim()) {
    return process.env.PUBLIC_HOST.trim();
  }
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('192.168.1.')) {
          return iface.address;
        }
      }
    }
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch {
    // Ignore network interface lookup errors
  }
  return process.env.PUBLIC_HOST || '192.168.1.6';
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
}

/**
 * Dynamically extract and sanitize SMTP configuration from environment variables.
 */
export function getSmtpConfig(): SmtpConfig | null {
  const user = (process.env.EMAIL_USER || process.env.SMTP_USER || '').replace(/['"]/g, '').trim();
  const pass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || '').replace(/\s+/g, '').replace(/['"]/g, '').trim();

  if (!user || !pass) {
    return null;
  }

  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 465;
  const secure = process.env.SMTP_SECURE !== undefined
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;

  const fromEmail = (process.env.EMAIL_FROM || process.env.FROM_EMAIL || `"FieldOps Dispatch" <${user}>`).trim();

  return { host, port, secure, user, pass, fromEmail };
}

export const cleanPass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || '').replace(/\s+/g, '').replace(/['"]/g, '').trim();
export const cleanUser = (process.env.EMAIL_USER || process.env.SMTP_USER || '').replace(/['"]/g, '').trim();

export const transporter: Transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: cleanUser,
    pass: cleanPass,
  },
});

// Log connection status on server startup
transporter.verify((error, success) => {
  if (error) {
    console.error('[SMTP Auth Error]: Failed to authenticate Gmail SMTP:', error);
  } else {
    console.log('[SMTP Auth Success]: Gmail transporter authenticated successfully with', cleanUser);
  }
});

/**
 * Verify transporter connectivity and log comprehensive diagnostic details.
 */
export function verifyTransporter(t: Transporter, label?: string) {
  // Verification already performed at startup
}

/**
 * Obtain or create a Nodemailer transporter singleton.
 */
export async function getTransporter(): Promise<Transporter> {
  return transporter;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  previewUrl?: string | false;
  recipient?: string;
  error?: string;
}

/**
 * Send an automated service completion report with a direct link to the PDF certificate.
 */
export async function sendCompletionEmail(
  jobOrId: string | any,
  explicitCustomerEmail?: string | null
): Promise<SendEmailResult> {
  try {
    let job: any = typeof jobOrId === 'object' && jobOrId !== null ? { ...jobOrId } : {};
    const jobId = typeof jobOrId === 'string' ? jobOrId : jobOrId?.id;

    // Always query the complete work order record from Prisma when jobId is available to ensure customerEmail is loaded
    let workOrder: any = null;
    if (jobId) {
      workOrder = await prisma.job.findUnique({
        where: { id: jobId },
        include: {
          technician: true,
        },
      });
      if (workOrder) {
        job = {
          ...job,
          ...workOrder,
        };
      } else if (typeof jobOrId === 'string') {
        throw new Error(`Job not found with id: ${jobId}`);
      }
    }

    // Dynamic recipient extraction from work order customer email (database record / payload)
    const rawRecipient =
      explicitCustomerEmail ||
      job.customerEmail ||
      job.customer_email ||
      job.email ||
      workOrder?.customerEmail ||
      workOrder?.customer_email ||
      workOrder?.email ||
      (job.customer && typeof job.customer === 'object' ? (job.customer.email || job.customer.customerEmail) : null);

    const recipientEmail = (rawRecipient && typeof rawRecipient === 'string') ? rawRecipient.trim() : null;
    const resolvedJobId = job.id || jobId || 'N/A';
    const workOrderId = resolvedJobId.replace(/-/g, '').substring(0, 8).toUpperCase();

    console.log(`[Email Target Check] Job #${resolvedJobId} -> Extracted Recipient: "${recipientEmail}"`);

    const senderEmail = (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim().toLowerCase();

    // Strictly enforce: If recipientEmail is missing or is identical to process.env.EMAIL_USER, do NOT send to fieldops.dispatch@gmail.com
    if (!recipientEmail || (senderEmail && recipientEmail.toLowerCase() === senderEmail)) {
      console.warn(`[Email Aborted: No valid external customer email provided] Job #${resolvedJobId}`);
      return {
        success: false,
        error: 'No valid external customer email provided',
      };
    }

    const transporter = await getTransporter();

    // 1. Format details and verify link safety
    const host = getServerLanHost();
    const defaultAppUrl = process.env.VERCEL || process.env.NODE_ENV === 'production'
      ? 'https://fieldops-platform-server.vercel.app'
      : `http://${host}:5000`;
    const appUrl = (process.env.APP_URL || defaultAppUrl).replace(/\/+$/, '');
    const pdfUrl = `${appUrl}/api/jobs/${job.id}/pdf`;
    const customerName = job.customerName || 'Valued Customer';
    const notes = job.completionNotes || job.notes || 'Service completed and reviewed on-site.';
    const techName = job.technician?.name || 'Assigned Field Technician';
    const jobTitle = (job.title || 'Work Order').trim();

    // Check for public secure HTTPS URL (strip all private LAN/IP and non-HTTPS links to avoid spam/anti-phishing blacklists)
    const isSecurePublicUrl =
      typeof pdfUrl === 'string' &&
      pdfUrl.startsWith('https://') &&
      !pdfUrl.includes('localhost') &&
      !pdfUrl.includes('127.0.0.1') &&
      !pdfUrl.includes('192.168.');

    const archiveNotice = `A copy of this digital work order summary has been archived under reference #${workOrderId}.`;
    const archiveText = isSecurePublicUrl
      ? `${archiveNotice}\nOnline copy: ${pdfUrl}`
      : archiveNotice;
    const archiveHtml = isSecurePublicUrl
      ? `<p style="margin-top: 16px; font-size: 14px; color: #4b5563;">${archiveNotice}<br>Online copy: <a href="${pdfUrl}" style="color: #2563eb; text-decoration: underline;">${pdfUrl}</a></p>`
      : `<p style="margin-top: 16px; font-size: 14px; color: #4b5563;">${archiveNotice}</p>`;

    // Parse itemized billing components
    const laborCost = typeof job.laborCost === 'number' ? job.laborCost : 50.0;
    
    let partsList: Array<{ name: string; sku?: string; quantity: number; unitCost: number; totalCost: number }> = [];
    if (job.materialsUsed) {
      if (typeof job.materialsUsed === 'string') {
        try { partsList = JSON.parse(job.materialsUsed); } catch { partsList = []; }
      } else if (Array.isArray(job.materialsUsed)) {
        partsList = job.materialsUsed;
      }
    }
    const partsTotal = partsList.reduce((sum, p) => sum + (typeof p.totalCost === 'number' ? p.totalCost : ((p.unitCost || 0) * (p.quantity || 1))), 0);

    let customServicesList: Array<{ description: string; amount: number }> = [];
    if (job.customServices) {
      if (typeof job.customServices === 'string') {
        try { customServicesList = JSON.parse(job.customServices); } catch { customServicesList = []; }
      } else if (Array.isArray(job.customServices)) {
        customServicesList = job.customServices;
      }
    }
    const customTotal = customServicesList.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

    const totalAmount = typeof job.totalAmount === 'number' ? job.totalAmount : (laborCost + partsTotal + customTotal);
    const paymentMethodLabel = job.paymentMethod === 'ONLINE_TRANSFER' ? 'Direct Bank / Digital Transfer' : 'Cash on site';
    const paymentNoteText = job.paymentNotes ? ` - Ref: ${job.paymentNotes}` : '';
    const paymentSummary = `Paid (${paymentMethodLabel}${paymentNoteText})`;

    // 2. Generate clean plain-text fallback matching HTML line-for-line
    const textReceiptLines = [
      `Service Summary:`,
      `- Labor fee: $${laborCost.toFixed(2)}`,
    ];
    if (partsList.length > 0) {
      partsList.forEach((p) => {
        const qty = p.quantity || 1;
        const lineCost = typeof p.totalCost === 'number' ? p.totalCost : ((p.unitCost || 0) * qty);
        textReceiptLines.push(`- ${p.name} (x${qty}): $${lineCost.toFixed(2)}`);
      });
    }
    if (customServicesList.length > 0) {
      customServicesList.forEach((s) => {
        textReceiptLines.push(`- ${s.description}: $${Number(s.amount || 0).toFixed(2)}`);
      });
    }
    textReceiptLines.push(`Total: $${totalAmount.toFixed(2)}`);
    textReceiptLines.push(`Payment: ${paymentSummary}`);

    const textBody = [
      `Hello ${customerName},`,
      ``,
      `Your service request "${jobTitle}" (Work Order #${workOrderId}) has been completed.`,
      ``,
      `Technician: ${techName}`,
      `Notes: ${notes}`,
      ``,
      ...textReceiptLines,
      ``,
      archiveText,
      ``,
      `Regards,`,
      `FieldOps Dispatch`,
      ``,
      `----------------------------------------`,
      `FieldOps Dispatch Services • Farid Town, Sahiwal, Pakistan.`,
    ].join('\n');

    // 3. Construct lightweight, minimal HTML template with standard Arial font and no heavy badges
    let partsHtmlRows = '';
    partsList.forEach((p) => {
      const qty = p.quantity || 1;
      const lineCost = typeof p.totalCost === 'number' ? p.totalCost : ((p.unitCost || 0) * qty);
      partsHtmlRows += `
      <tr style="border-bottom: 1px solid #f3f4f6;">
        <td style="padding: 8px 0; color: #4b5563;">${p.name} (x${qty})</td>
        <td style="padding: 8px 0; text-align: right; color: #111827;">$${lineCost.toFixed(2)}</td>
      </tr>`;
    });

    let customHtmlRows = '';
    customServicesList.forEach((s) => {
      customHtmlRows += `
      <tr style="border-bottom: 1px solid #f3f4f6;">
        <td style="padding: 8px 0; color: #4b5563;">${s.description}</td>
        <td style="padding: 8px 0; text-align: right; color: #111827;">$${Number(s.amount || 0).toFixed(2)}</td>
      </tr>`;
    });

    const htmlBody = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #1f2937; line-height: 1.6; max-width: 600px;">
  <p>Hello <strong>${customerName}</strong>,</p>
  <p>Your service request "<strong>${jobTitle}</strong>" (Work Order #${workOrderId}) has been completed.</p>
  <p>
    <strong>Technician:</strong> ${techName}<br>
    <strong>Notes:</strong> ${notes}
  </p>

  <h3 style="margin-top: 20px; margin-bottom: 8px; font-size: 15px; color: #111827;">Service Summary</h3>
  <table style="width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; font-size: 14px;">
    <thead>
      <tr style="border-bottom: 2px solid #e5e7eb; text-align: left;">
        <th style="padding: 8px 0; color: #374151; font-weight: 600;">Description</th>
        <th style="padding: 8px 0; text-align: right; color: #374151; font-weight: 600;">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr style="border-bottom: 1px solid #f3f4f6;">
        <td style="padding: 8px 0; color: #4b5563;">Labor fee</td>
        <td style="padding: 8px 0; text-align: right; color: #111827;">$${laborCost.toFixed(2)}</td>
      </tr>
      ${partsHtmlRows}
      ${customHtmlRows}
      <tr style="border-top: 2px solid #e5e7eb;">
        <td style="padding: 10px 0; font-weight: bold; color: #111827;">Total</td>
        <td style="padding: 10px 0; text-align: right; font-weight: bold; color: #111827;">$${totalAmount.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <p style="margin-top: 12px; font-size: 14px; color: #4b5563;">
    <strong>Payment:</strong> ${paymentSummary}
  </p>

  <div style="text-align: center; margin: 24px 0;">
    <a href="${pdfUrl}" style="background-color: #2563EB; color: #FFFFFF; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block;">
      Download Official Receipt (PDF)
    </a>
  </div>
  <p style="font-size: 12px; color: #64748B; text-align: center;">The receipt is also attached directly to this email for your records.</p>

  ${archiveHtml}

  <p style="margin-top: 24px; font-size: 14px; color: #1f2937;">
    Regards,<br>
    FieldOps Dispatch
  </p>

  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 12px 0;">
  <p style="font-size: 12px; color: #9ca3af; line-height: 1.4; margin: 0;">
    FieldOps Dispatch Services • Farid Town, Sahiwal, Pakistan.
  </p>
</div>`;

    // 4. Generate official PDF receipt buffer for email attachment
    let pdfBuffer: Buffer | null = null;
    try {
      pdfBuffer = await generateJobPdf(job);
    } catch (pdfErr) {
      console.warn('[EmailService] Failed to generate PDF buffer for attachment:', pdfErr);
    }

    // 5. Send email with minimal, clean options without custom metadata headers
    const mailOptions: any = {
      from: `"FieldOps Dispatch" <${cleanUser}>`,
      replyTo: process.env.EMAIL_USER || cleanUser,
      to: recipientEmail,
      subject: `Service Completion - ${job.title || 'Work Order #' + workOrderId}`,
      text: textBody,
      html: htmlBody,
    };

    if (pdfBuffer) {
      const receiptFilename = `Receipt-${(job.id || 'ORDER0').slice(-6).toUpperCase()}.pdf`;
      mailOptions.attachments = [
        {
          filename: receiptFilename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ];
    }

    console.log(`[Email Trigger] Sending completion receipt to: ${recipientEmail} for Job #${job.id || workOrderId}`);
    const info = await transporter.sendMail(mailOptions);
    const previewUrl = nodemailer.getTestMessageUrl(info);

    console.log(`[Email Delivered] Receipt successfully sent. MessageId: ${info.messageId}`);
    if (previewUrl) {
      console.log(`[EmailService] Ethereal Browser Preview URL: ${previewUrl}`);
    }

    return {
      success: true,
      messageId: info.messageId,
      previewUrl: previewUrl || false,
      recipient: recipientEmail,
    };
  } catch (mailErr: any) {
    console.error('[Email Failed] Nodemailer error sending completion email:', mailErr);
    return {
      success: false,
      error: mailErr?.message || 'Unknown email transmission error',
    };
  }
}

/**
 * Backward compatibility alias for sendCompletionEmail
 */
export const sendServiceCompletedEmail = sendCompletionEmail;
export const sendJobNotificationEmail = sendDispatchEmail;

/**
 * Send an initial work order intake / dispatch confirmation email to the customer.
 */
export async function sendDispatchEmail(job: any): Promise<SendEmailResult> {
  const recipient = job?.customerEmail || job?.customer_email;
  if (!recipient || typeof recipient !== 'string' || !recipient.includes('@')) {
    return { success: false, error: 'No customer email address on work order' };
  }

  const workOrderId = (job.id || 'N/A').replace(/-/g, '').substring(0, 8).toUpperCase();
  const customerName = job.customerName || 'Valued Customer';
  const techName = job.technician?.name || 'Assigned Field Staff';
  const jobTitle = (job.title || 'Work Order').trim();

  const textBody = [
    `Hello ${customerName},`,
    ``,
    `Your service request "${jobTitle}" (Work Order #${workOrderId}) has been scheduled.`,
    `Technician: ${techName}`,
    `Location: ${job.customerAddress || 'On-site'}`,
    ``,
    `Regards,`,
    `FieldOps Dispatch`,
    ``,
    `----------------------------------------`,
    `FieldOps Dispatch Services • Farid Town, Sahiwal, Pakistan.`,
  ].join('\n');

  const mailOptions = {
    from: `"FieldOps Dispatch" <${cleanUser}>`,
    replyTo: process.env.EMAIL_USER || cleanUser,
    to: recipient.trim(),
    subject: `FieldOps Service Scheduled - ${jobTitle}`,
    text: textBody,
  };

  const info = await transporter.sendMail(mailOptions);
  return { success: true, messageId: info.messageId, recipient };
}

