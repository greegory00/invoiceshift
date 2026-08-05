const express = require('express');
const pdfParseModule = require('pdf-parse');
const path = require('path');

const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : (pdfParseModule.default || pdfParseModule);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseEuropeanNumber(str) {
  if (!str) return 0;
  let clean = str.replace(/[^\d\.,]/g, '').trim();
  
  if (clean.includes('.') && clean.includes(',')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    clean = clean.replace(',', '.');
  }
  return parseFloat(clean) || 0;
}

function parseInvoiceText(text) {
  const cleanText = text.replace(/\r/g, ' ');

  // 1. NÚMERO DE DOCUMENTO
  const invoiceNumRegexes = [
    /(?:num(?:ero)?\s*factura|nº\s*factura|factura\s*nº|factura\s*num|factura\s*n°|nº\s*doc|nº\s*de\s*factura|nº\s*ref|fra\.\s*nº)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{2,25})/i,
    /(?:factura|invoice|nº|numero)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{3,20})/i
  ];

  let invoiceNumber = 'S/N';
  for (const regex of invoiceNumRegexes) {
    const match = cleanText.match(regex);
    if (match && match[1] && match[1].trim().length > 1) {
      const candidate = match[1].trim();
      const forbidden = ['TOTAL', 'FECHA', 'IMPORTE', 'CLIENTE', 'PAGINA', 'FACTURA', 'BASE'];
      if (!forbidden.includes(candidate.toUpperCase())) {
        invoiceNumber = candidate;
        break;
      }
    }
  }

  // 2. FECHA
  const dateRegex = /(?:fecha|date|f\.\s*factura)\s*[:\.\-]?\s*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/i;
  const dateMatch = cleanText.match(dateRegex) || cleanText.match(/(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

  // 3. IMPORTE TOTAL
  const strictTotalRegex = /(?:total\s*factura|total\s*a\s*pagar|importe\s*total|liquido\s*a\s*pagar|total\s*eur|total\s*€|total\s*doc)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i;
  const strictMatch = cleanText.match(strictTotalRegex);
  let amount = 0;

  if (strictMatch && strictMatch[1]) {
    amount = parseEuropeanNumber(strictMatch[1]);
  } else {
    const genericTotalRegex = /(?:total|importe)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/gi;
    let matches = [];
    let match;
    while ((match = genericTotalRegex.exec(cleanText)) !== null) {
      const val = parseEuropeanNumber(match[1]);
      if (val > 0) matches.push(val);
    }
    if (matches.length > 0) {
      const withDecimals = matches.filter(v => v % 1 !== 0);
      amount = withDecimals.length > 0 ? withDecimals[withDecimals.length - 1] : matches[0];
    }
  }

  // 4. BASE IMPONIBLE
  const baseRegex = /(?:base\s*imponible|subtotal|b\.i\.|base\s*imp\.)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i;
  const baseMatch = cleanText.match(baseRegex);
  let baseAmount = baseMatch ? parseEuropeanNumber(baseMatch[1]) : 0;

  // 5. CUOTA DE IVA
  const ivaRegex = /(?:cuota\s*iva|importe\s*iva|iva\s*21%|iva\s*10%|iva\s*4%)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i;
  const ivaMatch = cleanText.match(ivaRegex);
  let ivaAmount = ivaMatch ? parseEuropeanNumber(ivaMatch[1]) : 0;

  // LÓGICA DE RESPALDO SI FALTA ALGÚN DATO:
  if (baseAmount === 0 && amount > 0) {
    if (ivaAmount > 0) {
      // Si tenemos Total e IVA -> Base = Total - IVA
      baseAmount = amount - ivaAmount;
    } else {
      // Si solo tenemos Total, estimamos Base dividiendo por 1.21 (IVA 21%)
      baseAmount = amount / 1.21;
      ivaAmount = amount - baseAmount;
    }
  } else if (ivaAmount === 0 && amount > 0 && baseAmount > 0) {
    // Si tenemos Total y Base -> IVA = Total - Base
    ivaAmount = amount - baseAmount;
  }

  return {
    invoiceNumber,
    date,
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    ivaAmount: parseFloat(ivaAmount.toFixed(2)),
    amount: parseFloat(amount.toFixed(2))
  };
}

async function processPdfBuffer(buffer) {
  try {
    return await pdfParse(buffer);
  } catch (err) {
    if (err.message && err.message.includes("without 'new'")) {
      return await new pdfParse(buffer);
    }
    throw err;
  }
}

app.post('/api/parse-pdf', async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body;

    if (!fileBase64) {
      return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    }

    const base64Data = fileBase64.includes(',') 
      ? fileBase64.split(',')[1] 
      : fileBase64;

    const buffer = Buffer.from(base64Data, 'base64');
    const pdfData = await processPdfBuffer(buffer);

    if (!pdfData || !pdfData.text || pdfData.text.trim().length === 0) {
      return res.status(400).json({ 
        error: 'El PDF es un escáner/imagen sin texto interno.' 
      });
    }

    const extractedData = parseInvoiceText(pdfData.text);

    console.log(`📄 ${fileName} | Base: ${extractedData.baseAmount}€ | IVA: ${extractedData.ivaAmount}€ | Total: ${extractedData.amount}€`);

    return res.json({
      success: true,
      fileName: fileName || 'factura.pdf',
      data: extractedData
    });

  } catch (error) {
    console.error('❌ ERROR EN SERVIDOR:', error.message);
    return res.status(500).json({ 
      error: `Error al procesar: ${error.message}` 
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 ¡Servidor InvoiceShift activo!`);
  console.log(`👉 Abre tu navegador en: http://localhost:${PORT}\n`);
});