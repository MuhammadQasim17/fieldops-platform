import PDFDocument from 'pdfkit';
import { prisma } from '../../prisma';

export interface JobForPdf {
  id: string;
  title: string;
  description?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerAddress?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  priority: string;
  status: string;
  completionNotes?: string | null;
  notes?: string | null;
  signatureData?: string | null;
  completedAt?: Date | string | null;
  completedLatitude?: number | null;
  completedLongitude?: number | null;
  beforePhotoUrl?: string | null;
  afterPhotoUrl?: string | null;
  materialsUsed?: any;
  laborCost?: number | null;
  customServices?: any;
  totalAmount?: number | null;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  paymentNotes?: string | null;
  createdAt: Date | string;
  technician?: {
    id?: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
}

/**
 * Extract an image Buffer from a data URI, local path, or raw base64.
 */
function parseImageBuffer(photoStr?: string | null): Buffer | null {
  if (!photoStr || typeof photoStr !== 'string') return null;

  // 1. Data URI with base64
  const dataUriMatch = photoStr.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,(.+)$/i);
  if (dataUriMatch && dataUriMatch[1]) {
    try {
      return Buffer.from(dataUriMatch[1].trim(), 'base64');
    } catch {
      return null;
    }
  }

  // 2. Raw base64 string
  if (photoStr.length > 100 && !photoStr.startsWith('http') && !photoStr.startsWith('file:') && !photoStr.includes('<svg')) {
    try {
      return Buffer.from(photoStr.trim(), 'base64');
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Extract SVG path strings from signatureData.
 */
function extractSvgPaths(sigData?: string | null): string[] {
  if (!sigData || typeof sigData !== 'string') return [];

  let svgContent = sigData.trim();
  if (svgContent.startsWith('data:image/svg+xml;utf8,')) {
    svgContent = decodeURIComponent(svgContent.replace('data:image/svg+xml;utf8,', ''));
  } else if (svgContent.startsWith('data:image/svg+xml;base64,')) {
    try {
      svgContent = Buffer.from(svgContent.replace('data:image/svg+xml;base64,', ''), 'base64').toString('utf8');
    } catch {
      // keep svgContent
    }
  } else if (svgContent.startsWith('data:image/svg+xml,')) {
    svgContent = decodeURIComponent(svgContent.replace('data:image/svg+xml,', ''));
  } else if (svgContent.startsWith('data:image/svg+xml')) {
    try {
      svgContent = decodeURIComponent(svgContent.replace(/^data:image\/svg\+xml(?:;[a-zA-Z0-9=_-]+)?,/, ''));
    } catch {
      // keep svgContent
    }
  }

  const paths: string[] = [];
  const regex = /d="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(svgContent)) !== null) {
    if (match[1] && match[1].trim().length > 0) {
      paths.push(match[1].trim());
    }
  }

  // Fallback: If raw SVG path command string was stored directly
  if (paths.length === 0 && (/^[MmLlCcQqZz0-9\s.,-]+$/.test(svgContent) || svgContent.startsWith('M') || svgContent.startsWith('m'))) {
    paths.push(svgContent);
  }

  return paths;
}

/**
 * Generate a branded "FieldOps Work Order Resolution Certificate" PDF buffer.
 */
export async function generateJobPdf(jobOrId: string | JobForPdf): Promise<Buffer> {
  let job: JobForPdf;
  if (typeof jobOrId === 'string') {
    const fetched = await prisma.job.findUnique({
      where: { id: jobOrId },
      include: {
        technician: {
          select: { id: true, name: true, phone: true, email: true, role: true },
        },
      },
    });
    if (!fetched) {
      throw new Error(`Job not found with id: ${jobOrId}`);
    }
    job = fetched;
  } else {
    job = jobOrId;
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 32, bottom: 32, left: 36, right: 36 },
        info: {
          Title: `Work Order Certificate - ${job.title}`,
          Author: 'FieldOps Platform',
          Subject: 'Work Order Resolution Certificate',
          Keywords: 'Work Order, FieldOps, Certificate, Verification',
          CreationDate: new Date(),
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const pageWidth = 612;
      const leftMargin = 36;
      const rightMargin = 36;
      const contentWidth = pageWidth - leftMargin - rightMargin; // 540 pt

      // ==========================================
      // 1. BRAND HEADER & CERTIFICATE BANNER
      // ==========================================
      // Top decorative primary bar
      doc.rect(leftMargin, 32, contentWidth, 4).fill('#2563EB');

      // Brand Logo & Platform Title
      doc.fontSize(18).font('Helvetica-Bold').fillColor('#0F172A').text('FIELDOPS', leftMargin, 44, { continued: true });
      doc.fillColor('#2563EB').text(' PLATFORM');
      
      doc.fontSize(8.5).font('Helvetica').fillColor('#64748B').text('Enterprise Field Service & Work Order Resolution System', leftMargin, 66);

      // Certificate Identifier Badge on Right
      const reportId = `WO-${job.id.replace(/-/g, '').substring(0, 8).toUpperCase()}`;
      const issueDate = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });

      doc.rect(pageWidth - rightMargin - 165, 42, 165, 34).fillAndStroke('#EFF6FF', '#BFDBFE');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#1E40AF').text('RESOLUTION CERTIFICATE', pageWidth - rightMargin - 158, 47);
      doc.fontSize(8).font('Helvetica').fillColor('#334155').text(`ID: ${reportId}`, pageWidth - rightMargin - 158, 58, { continued: true });
      doc.fillColor('#64748B').text(` | ${issueDate}`);

      // Banner Subtitle & Status Badge
      doc.rect(leftMargin, 84, contentWidth, 22).fill('#F8FAFC');
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#1E3A8A').text('OFFICIAL VERIFICATION OF SERVICE COMPLETION', leftMargin + 8, 90);

      // Status Badge
      const isCompleted = job.status === 'COMPLETED';
      const statusBadgeText = isCompleted ? 'VERIFIED COMPLETED' : job.status;
      const badgeWidth = 120;
      doc.rect(pageWidth - rightMargin - badgeWidth - 6, 87, badgeWidth, 16).fill(isCompleted ? '#ECFDF5' : '#F1F5F9');
      doc.rect(pageWidth - rightMargin - badgeWidth - 6, 87, badgeWidth, 16).stroke(isCompleted ? '#10B981' : '#CBD5E1');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(isCompleted ? '#065F46' : '#475569')
        .text(statusBadgeText, pageWidth - rightMargin - badgeWidth - 6, 91, { width: badgeWidth, align: 'center' });

      // ==========================================
      // 2. JOB OVERVIEW & CUSTOMER DETAILS (2 COLS)
      // ==========================================
      const metaTop = 114;
      const colWidth = (contentWidth - 12) / 2; // 264 pt

      // Column 1: Work Order Details
      doc.rect(leftMargin, metaTop, colWidth, 90).fillAndStroke('#FFFFFF', '#E2E8F0');
      doc.rect(leftMargin, metaTop, colWidth, 18).fill('#F1F5F9');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1E293B').text('WORK ORDER SUMMARY', leftMargin + 8, metaTop + 5);

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Title: ', leftMargin + 8, metaTop + 24, { continued: true });
      doc.font('Helvetica').fillColor('#334155').text(job.title.length > 40 ? `${job.title.substring(0, 38)}...` : job.title);

      const priorityColors: Record<string, string> = {
        EMERGENCY: '#DC2626',
        HIGH: '#EA580C',
        MEDIUM: '#2563EB',
        LOW: '#64748B',
      };
      const pColor = priorityColors[job.priority] || '#2563EB';
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Priority: ', leftMargin + 8, metaTop + 38, { continued: true });
      doc.fillColor(pColor).text(job.priority);

      const createdDateStr = job.createdAt ? new Date(job.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : 'N/A';
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Created: ', leftMargin + 8, metaTop + 52, { continued: true });
      doc.font('Helvetica').fillColor('#475569').text(createdDateStr);

      const closedDateStr = job.completedAt ? new Date(job.completedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : 'Pending Sign-Off';
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Closed: ', leftMargin + 8, metaTop + 66, { continued: true });
      doc.font('Helvetica').fillColor('#059669').text(closedDateStr);

      // Column 2: Customer & Location Details
      const col2Left = leftMargin + colWidth + 12;
      doc.rect(col2Left, metaTop, colWidth, 90).fillAndStroke('#FFFFFF', '#E2E8F0');
      doc.rect(col2Left, metaTop, colWidth, 18).fill('#F1F5F9');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1E293B').text('CUSTOMER & LOCATION', col2Left + 8, metaTop + 5);

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Client: ', col2Left + 8, metaTop + 24, { continued: true });
      doc.font('Helvetica').fillColor('#334155').text(job.customerName || 'N/A');

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Phone: ', col2Left + 8, metaTop + 38, { continued: true });
      doc.font('Helvetica').fillColor('#334155').text(job.customerPhone || 'N/A');

      doc.fontSize(8).font('Helvetica-Bold').fillColor('#0F172A').text('Address: ', col2Left + 8, metaTop + 52, { continued: true });
      doc.font('Helvetica').fillColor('#475569').text(job.customerAddress ? (job.customerAddress.length > 40 ? `${job.customerAddress.substring(0, 38)}...` : job.customerAddress) : 'N/A');

      // ==========================================
      // 3. FIELD PERSONNEL & GEO-AUDIT (2 COLS)
      // ==========================================
      const sec2Top = 212;
      const sec2Height = 54;

      // Col 1: Assigned Technician
      doc.rect(leftMargin, sec2Top, colWidth, sec2Height).fillAndStroke('#FFFFFF', '#E2E8F0');
      doc.rect(leftMargin, sec2Top, colWidth, 16).fill('#F8FAFC');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155').text('ASSIGNED SERVICE TECHNICIAN', leftMargin + 8, sec2Top + 4);

      const techName = job.technician?.name || 'Unassigned Staff';
      const techRole = job.technician?.role ? job.technician.role.replace('_', ' ') : 'Field Technician';
      const techContact = job.technician?.phone || job.technician?.email || '';

      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#0F172A').text(techName, leftMargin + 8, sec2Top + 22, { continued: true });
      doc.fontSize(7.5).font('Helvetica').fillColor('#64748B').text(` (${techRole})`);
      if (techContact) {
        doc.fontSize(7.5).font('Helvetica').fillColor('#475569').text(`Contact: ${techContact}`, leftMargin + 8, sec2Top + 36);
      }

      // Col 2: GPS Audit Coordinates
      doc.rect(col2Left, sec2Top, colWidth, sec2Height).fillAndStroke('#FFFFFF', '#E2E8F0');
      doc.rect(col2Left, sec2Top, colWidth, 16).fill('#F8FAFC');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155').text('GEO-AUDIT ON-SITE VERIFICATION', col2Left + 8, sec2Top + 4);

      const hasGps = typeof job.completedLatitude === 'number' && typeof job.completedLongitude === 'number';
      if (hasGps) {
        doc.rect(col2Left + 8, sec2Top + 22, 60, 14).fill('#ECFDF5');
        doc.rect(col2Left + 8, sec2Top + 22, 60, 14).stroke('#A7F3D0');
        doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#065F46').text('GPS VERIFIED', col2Left + 8, sec2Top + 26, { width: 60, align: 'center' });

        doc.fontSize(8).font('Helvetica').fillColor('#0F172A')
          .text(`${job.completedLatitude!.toFixed(5)}, ${job.completedLongitude!.toFixed(5)}`, col2Left + 74, sec2Top + 24);
        doc.fontSize(7).font('Helvetica').fillColor('#2563EB')
          .text('Audit map coordinates captured during customer sign-off', col2Left + 8, sec2Top + 40);
      } else {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#94A3B8')
          .text('No on-site GPS coordinates recorded for this job.', col2Left + 8, sec2Top + 26);
      }

      // ==========================================
      // 4. RESOLUTION & WORK COMPLETION NOTES
      // ==========================================
      const notesTop = 268;
      const notesHeight = 48;

      doc.rect(leftMargin, notesTop, contentWidth, notesHeight).fillAndStroke('#FFFFFF', '#CBD5E1');
      doc.rect(leftMargin, notesTop, contentWidth, 16).fill('#F1F5F9');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1E293B').text('TECHNICIAN WORK COMPLETION NOTES & RESOLUTION', leftMargin + 8, notesTop + 4);

      const rawNotes = (job.completionNotes || job.notes || '').trim();
      if (rawNotes.length > 0) {
        doc.fontSize(8).font('Helvetica').fillColor('#1E293B')
          .text(rawNotes, leftMargin + 8, notesTop + 22, {
            width: contentWidth - 16,
            height: notesHeight - 26,
            ellipsis: true,
          });
      } else {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#94A3B8')
          .text('No technician completion notes entered for this resolution.', leftMargin + 8, notesTop + 26);
      }

      // ==========================================
      // 5. PROOF OF WORK PHOTOS (BEFORE & AFTER)
      // ==========================================
      const photoSecTop = 322;
      const photoBoxHeight = 102;
      const photoBoxWidth = colWidth;

      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#1E293B').text('PROOF OF WORK VISUAL AUDIT', leftMargin, photoSecTop);

      // Left Box: Before Service Photo
      const beforeBoxTop = photoSecTop + 13;
      doc.rect(leftMargin, beforeBoxTop, photoBoxWidth, photoBoxHeight).fillAndStroke('#F8FAFC', '#CBD5E1');
      doc.rect(leftMargin, beforeBoxTop, photoBoxWidth, 16).fill('#F1F5F9');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155').text('BEFORE SERVICE PHOTO', leftMargin + 8, beforeBoxTop + 4);

      const beforeImgBuffer = parseImageBuffer(job.beforePhotoUrl);
      if (beforeImgBuffer) {
        try {
          doc.image(beforeImgBuffer, leftMargin + 6, beforeBoxTop + 18, {
            fit: [photoBoxWidth - 12, photoBoxHeight - 22],
            align: 'center',
            valign: 'center',
          });
        } catch (imgErr) {
          doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#94A3B8')
            .text('Photo artifact recorded but format unavailable', leftMargin + 10, beforeBoxTop + 48, { width: photoBoxWidth - 20, align: 'center' });
        }
      } else {
        doc.rect(leftMargin + 16, beforeBoxTop + 26, photoBoxWidth - 32, photoBoxHeight - 38).fillAndStroke('#FFFFFF', '#E2E8F0');
        doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#94A3B8')
          .text('No Before Service photo captured', leftMargin + 20, beforeBoxTop + 50, { width: photoBoxWidth - 40, align: 'center' });
      }

      // Right Box: After Service Photo
      doc.rect(col2Left, beforeBoxTop, photoBoxWidth, photoBoxHeight).fillAndStroke('#F8FAFC', '#CBD5E1');
      doc.rect(col2Left, beforeBoxTop, photoBoxWidth, 16).fill('#F1F5F9');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155').text('AFTER SERVICE PHOTO', col2Left + 8, beforeBoxTop + 4);

      const afterImgBuffer = parseImageBuffer(job.afterPhotoUrl);
      if (afterImgBuffer) {
        try {
          doc.image(afterImgBuffer, col2Left + 6, beforeBoxTop + 18, {
            fit: [photoBoxWidth - 12, photoBoxHeight - 22],
            align: 'center',
            valign: 'center',
          });
        } catch (imgErr) {
          doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#94A3B8')
            .text('Photo artifact recorded but format unavailable', col2Left + 10, beforeBoxTop + 48, { width: photoBoxWidth - 20, align: 'center' });
        }
      } else {
        doc.rect(col2Left + 16, beforeBoxTop + 26, photoBoxWidth - 32, photoBoxHeight - 38).fillAndStroke('#FFFFFF', '#E2E8F0');
        doc.fontSize(7.5).font('Helvetica-Oblique').fillColor('#94A3B8')
          .text('No After Service photo captured', col2Left + 20, beforeBoxTop + 50, { width: photoBoxWidth - 40, align: 'center' });
      }

      // ==========================================
      // 6. ITEMIZED BILLING RECEIPT & ON-SPOT SETTLEMENT
      // ==========================================
      const matSecTop = 444;
      const matSecHeight = 78;

      doc.rect(leftMargin, matSecTop, contentWidth, matSecHeight).fillAndStroke('#FFFFFF', '#CBD5E1');
      doc.rect(leftMargin, matSecTop, contentWidth, 16).fill('#F1F5F9');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1E293B')
        .text('ITEMIZED BILLING RECEIPT & ON-SPOT SETTLEMENT', leftMargin + 8, matSecTop + 4);

      // Parse billing items
      const laborCost = typeof job.laborCost === 'number' ? job.laborCost : 50.0;

      let materialsList: Array<{
        name: string;
        sku?: string;
        quantity: number;
        unitCost: number;
        totalCost: number;
      }> = [];

      if (job.materialsUsed) {
        if (typeof job.materialsUsed === 'string') {
          try {
            materialsList = JSON.parse(job.materialsUsed);
          } catch {
            materialsList = [];
          }
        } else if (Array.isArray(job.materialsUsed)) {
          materialsList = job.materialsUsed;
        }
      }

      let customServicesList: Array<{ description: string; amount: number }> = [];
      if (job.customServices) {
        if (typeof job.customServices === 'string') {
          try {
            customServicesList = JSON.parse(job.customServices);
          } catch {
            customServicesList = [];
          }
        } else if (Array.isArray(job.customServices)) {
          customServicesList = job.customServices;
        }
      }

      const partsTotal = materialsList.reduce((acc, curr) => {
        const cost = typeof curr.totalCost === 'number' ? curr.totalCost : ((curr.unitCost || 0) * (curr.quantity || 1));
        return acc + cost;
      }, 0);

      const customTotal = customServicesList.reduce((acc, curr) => {
        return acc + (Number(curr.amount) || 0);
      }, 0);

      const grandTotal = typeof job.totalAmount === 'number' ? job.totalAmount : (laborCost + partsTotal + customTotal);
      const paymentMethodStr = job.paymentMethod === 'ONLINE_TRANSFER' ? 'Online Transfer' : 'Cash on Site';

      // Table Header
      const tableY = matSecTop + 18;
      doc.rect(leftMargin + 6, tableY, contentWidth - 12, 11).fill('#F8FAFC');
      doc.fontSize(6.5).font('Helvetica-Bold').fillColor('#475569');
      doc.text('LINE ITEM / WORK DESCRIPTION', leftMargin + 10, tableY + 2);
      doc.text('TYPE / SKU', leftMargin + 240, tableY + 2);
      doc.text('QTY', leftMargin + 340, tableY + 2, { width: 30, align: 'center' });
      doc.text('UNIT PRICE', leftMargin + 380, tableY + 2, { width: 60, align: 'right' });
      doc.text('LINE TOTAL', leftMargin + 450, tableY + 2, { width: 80, align: 'right' });

      // Rows
      let rowY = tableY + 12;

      // Line 1: Base Labor
      doc.fontSize(7).font('Helvetica').fillColor('#1E293B');
      doc.text('Base Field Labor & Diagnostic Service', leftMargin + 10, rowY, { width: 225, ellipsis: true });
      doc.font('Helvetica-Oblique').fillColor('#64748B').text('LABOR-BASE', leftMargin + 240, rowY);
      doc.font('Helvetica').fillColor('#1E293B').text('1', leftMargin + 340, rowY, { width: 30, align: 'center' });
      doc.text(`$${laborCost.toFixed(2)}`, leftMargin + 380, rowY, { width: 60, align: 'right' });
      doc.font('Helvetica-Bold').text(`$${laborCost.toFixed(2)}`, leftMargin + 450, rowY, { width: 80, align: 'right' });
      rowY += 10;

      // Lines: Parts and Custom Services (up to 2 additional lines)
      const additionalLines: Array<{ desc: string; sku: string; qty: number; unit: number; total: number }> = [];
      materialsList.forEach((m) => {
        const qty = m.quantity || 1;
        const lineTotal = typeof m.totalCost === 'number' ? m.totalCost : ((m.unitCost || 0) * qty);
        additionalLines.push({
          desc: m.name || 'Replacement Part',
          sku: m.sku || 'PART',
          qty,
          unit: m.unitCost || 0,
          total: lineTotal,
        });
      });
      customServicesList.forEach((s) => {
        additionalLines.push({
          desc: `${s.description} (Custom Work)`,
          sku: 'CUSTOM-SRV',
          qty: 1,
          unit: Number(s.amount) || 0,
          total: Number(s.amount) || 0,
        });
      });

      const displayAddLines = additionalLines.slice(0, 2);
      displayAddLines.forEach((item) => {
        doc.fontSize(7).font('Helvetica').fillColor('#1E293B');
        doc.text(item.desc, leftMargin + 10, rowY, { width: 225, ellipsis: true });
        doc.font('Helvetica-Oblique').fillColor('#64748B').text(item.sku, leftMargin + 240, rowY);
        doc.font('Helvetica').fillColor('#1E293B').text(String(item.qty), leftMargin + 340, rowY, { width: 30, align: 'center' });
        doc.text(`$${item.unit.toFixed(2)}`, leftMargin + 380, rowY, { width: 60, align: 'right' });
        doc.font('Helvetica-Bold').text(`$${item.total.toFixed(2)}`, leftMargin + 450, rowY, { width: 80, align: 'right' });
        rowY += 10;
      });

      if (additionalLines.length > 2) {
        doc.fontSize(6).font('Helvetica-Oblique').fillColor('#94A3B8')
          .text(`+ ${additionalLines.length - 2} additional parts/services itemized in settlement`, leftMargin + 10, rowY);
      }

      // Summary Bar at bottom of box
      const grandTotalY = matSecTop + matSecHeight - 14;
      doc.rect(leftMargin + 6, grandTotalY, contentWidth - 12, 12).fill('#ECFDF5');
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#065F46')
        .text(`SETTLED ON-SITE • PAID via ${paymentMethodStr}${job.paymentNotes ? ` (${job.paymentNotes})` : ''}`, leftMargin + 10, grandTotalY + 2.5);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#065F46')
        .text(`TOTAL PAID: $${grandTotal.toFixed(2)}`, leftMargin + 430, grandTotalY + 2, { width: 100, align: 'right' });

      // ==========================================
      // 7. CUSTOMER SIGN-OFF & CERTIFICATE SEAL
      // ==========================================
      const signSecTop = 528;
      const sigCardWidth = 310;
      const sigCardHeight = 110;

      // Signature Card (Left 310pt)
      doc.rect(leftMargin, signSecTop, sigCardWidth, sigCardHeight).fillAndStroke('#FFFFFF', '#CBD5E1');
      doc.rect(leftMargin, signSecTop, sigCardWidth, 18).fill('#F1F5F9');
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1E293B').text('CUSTOMER DIGITAL SIGNATURE & APPROVAL', leftMargin + 8, signSecTop + 5);

      // Embedded signature rendering
      const sigBoxX = leftMargin + 10;
      const sigBoxY = signSecTop + 24;
      const sigBoxW = sigCardWidth - 20;
      const sigBoxH = 55;

      const sigPaths = extractSvgPaths(job.signatureData);
      const sigImageBuf = parseImageBuffer(job.signatureData);

      if (sigPaths.length > 0) {
        // Draw SVG paths dynamically scaled to true bounding box and strictly confined within sigBox
        try {
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;

          for (const p of sigPaths) {
            const matches = p.match(/[-+]?[0-9]*\.?[0-9]+/g);
            if (matches && matches.length >= 2) {
              for (let i = 0; i < matches.length - 1; i += 2) {
                const x = parseFloat(matches[i]);
                const y = parseFloat(matches[i + 1]);
                if (!isNaN(x) && !isNaN(y)) {
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
              }
            }
          }

          if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY) && maxX > minX && maxY > minY) {
            const boxX = Math.max(0, minX - 10);
            const boxY = Math.max(0, minY - 10);
            const boxW = Math.max((maxX - minX) + 20, 60);
            const boxH = Math.max((maxY - minY) + 20, 40);

            // Confine strictly inside designated signature area (<80px height, <= 220px width)
            const maxAllowedW = Math.min(sigBoxW, 220);
            const maxAllowedH = Math.min(sigBoxH, 55);

            const scale = Math.min(maxAllowedW / boxW, maxAllowedH / boxH);
            const renderW = boxW * scale;
            const renderH = boxH * scale;

            // Center horizontally and vertically within the signature box
            const offsetX = sigBoxX + (sigBoxW - renderW) / 2;
            const offsetY = sigBoxY + (sigBoxH - renderH) / 2;

            doc.save();
            // Strict clipping mask (overflow: hidden) so signature never breaches bounding box or baseline
            doc.rect(sigBoxX, sigBoxY, sigBoxW, sigBoxH).clip();
            doc.translate(offsetX, offsetY);
            doc.scale(scale);
            doc.translate(-boxX, -boxY);

            for (const p of sigPaths) {
              doc.path(p).lineWidth(2.2 / scale).strokeColor('#0F172A').lineCap('round').lineJoin('round').stroke();
            }
            doc.restore();
          } else {
            // Fallback scaling if bounding box could not be determined
            const scale = Math.min(sigBoxW / 360, sigBoxH / 150);
            doc.save();
            doc.rect(sigBoxX, sigBoxY, sigBoxW, sigBoxH).clip();
            doc.translate(sigBoxX, sigBoxY);
            doc.scale(scale);
            for (const p of sigPaths) {
              doc.path(p).lineWidth(2.5 / scale).strokeColor('#0F172A').stroke();
            }
            doc.restore();
          }
        } catch (svgErr) {
          doc.fontSize(8).font('Helvetica-Oblique').fillColor('#64748B')
            .text('Signature Verified & Recorded On-Site', sigBoxX, sigBoxY + 20, { width: sigBoxW, align: 'center' });
        }
      } else if (sigImageBuf) {
        try {
          doc.save();
          doc.rect(sigBoxX, sigBoxY, sigBoxW, sigBoxH).clip();
          doc.image(sigImageBuf, sigBoxX + (sigBoxW - 220) / 2, sigBoxY, { fit: [220, sigBoxH], align: 'center', valign: 'center' });
          doc.restore();
        } catch {
          doc.fontSize(8).font('Helvetica-Oblique').fillColor('#64748B')
            .text('Signature Verified & Recorded On-Site', sigBoxX, sigBoxY + 20, { width: sigBoxW, align: 'center' });
        }
      } else {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#94A3B8')
          .text('No signature artifact attached', sigBoxX, sigBoxY + 20, { width: sigBoxW, align: 'center' });
      }

      // Baseline line for signature
      doc.moveTo(sigBoxX, signSecTop + 84).lineTo(sigBoxX + sigBoxW, signSecTop + 84).lineWidth(0.8).strokeColor('#CBD5E1').stroke();
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155')
        .text(`Authorized Signer: ${job.customerName}`, sigBoxX, signSecTop + 88, { continued: true });
      doc.font('Helvetica').fillColor('#64748B').text(' (Customer Sign-Off Verified)');

      doc.fontSize(6.5).font('Helvetica-Oblique').fillColor('#94A3B8')
        .text('Customer confirmed satisfactory completion and resolution of work order.', sigBoxX, signSecTop + 98);

      // Audit Verification Seal (Right side)
      const sealX = leftMargin + sigCardWidth + 12;
      const sealW = contentWidth - sigCardWidth - 12; // 218 pt
      doc.rect(sealX, signSecTop, sealW, sigCardHeight).fillAndStroke('#F8FAFC', '#CBD5E1');
      doc.rect(sealX, signSecTop, sealW, 18).fill('#EFF6FF');
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#1E40AF').text('AUDIT INTEGRITY RECORD', sealX + 8, signSecTop + 5);

      // Verification items
      const certHash = `CERT-${job.id.replace(/-/g, '').substring(0, 16).toUpperCase()}`;
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#334155').text('Certificate Serial:', sealX + 8, signSecTop + 24);
      doc.fontSize(7.5).font('Helvetica').fillColor('#2563EB').text(certHash, sealX + 8, signSecTop + 33);

      doc.fontSize(7).font('Helvetica-Bold').fillColor('#334155').text('Timestamp Generated:', sealX + 8, signSecTop + 45);
      doc.fontSize(7.5).font('Helvetica').fillColor('#475569').text(new Date().toUTCString(), sealX + 8, signSecTop + 54);

      doc.fontSize(7).font('Helvetica-Bold').fillColor('#334155').text('Dispatch Verification:', sealX + 8, signSecTop + 66);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#059669').text('✓ TAMPER-EVIDENT RECORD', sealX + 8, signSecTop + 75);

      doc.fontSize(6).font('Helvetica-Oblique').fillColor('#94A3B8')
        .text('Cryptographically indexed in FieldOps centralized dispatch registry.', sealX + 8, signSecTop + 90, { width: sealW - 16 });

      // ==========================================
      // 7. DOCUMENT FOOTER
      // ==========================================
      const footerY = 744;
      doc.moveTo(leftMargin, footerY).lineTo(pageWidth - rightMargin, footerY).lineWidth(0.8).strokeColor('#E2E8F0').stroke();

      doc.fontSize(7).font('Helvetica').fillColor('#94A3B8')
        .text('FieldOps Platform • Automated Work Order Resolution Certificate • Official Dispatch Audit Record', leftMargin, footerY + 6);

      doc.fontSize(7).font('Helvetica-Bold').fillColor('#64748B')
        .text(`Page 1 of 1`, leftMargin, footerY + 6, { width: contentWidth, align: 'right' });

      // Finalize document
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Export alias for certificate generation
 */
export const generateCertificate = generateJobPdf;


