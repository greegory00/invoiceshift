const express = require('express');
const pdfParseModule = require('pdf-parse');
const path = require('path');
const fs = require('fs');

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

  // 1. NÚMERO DE DOCUMENTO (Con validaciones estrictas)
  const invoiceNumRegexes = [
    /(?:num(?:ero)?\s*factura|nº\s*factura|factura\s*nº|factura\s*num|factura\s*n°|nº\s*doc|nº\s*de\s*factura|fra\.\s*nº|factura\s*número)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{2,30})/i,
    /(?:nº\s*factura\s*simplificada|factura\s*simplificada\s*nº|nº\s*ticket)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{2,30})/i,
    /(?:factura|invoice)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{3,25})/i
  ];

  const forbiddenWords = [
    'TOTAL', 'FECHA', 'IMPORTE', 'CLIENTE', 'PAGINA', 'FACTURA', 'BASE', 
    'DE', 'PUEDES', 'DOCUMENTO', 'UMENTO', 'NUMERO', 'NÚMERO', 'Nº', 
    'CONCEPTO', 'PROVEEDOR', 'TITULAR', 'VENCIMIENTO', 'PAGO', 'SUMINISTRO'
  ];

  let invoiceNumber = 'S/N';
  for (const regex of invoiceNumRegexes) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      const candidate = match[1].trim();
      const upperCand = candidate.toUpperCase();

      const isForbidden = forbiddenWords.some(word => upperCand === word || upperCand.startsWith(word));
      const hasDigits = /\d/.test(candidate);

      // Exigimos que tenga al menos un número o formato con guiones/barras
      if (!isForbidden && candidate.length >= 2 && (hasDigits || candidate.includes('-') || candidate.includes('/'))) {
        invoiceNumber = candidate;
        break;
      }
    }
  }

  // 2. FECHA (Exige años de 4 dígitos)
  const dateRegexes = [
    /(?:fecha|date|f\.\s*factura|fecha\s*emisión|fecha\s*expedición)\s*[:\.\-]?\s*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/i,
    /(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/,
    /(\d{4}[\/\.-]\d{1,2}[\/\.-]\d{1,2})/
  ];

  let date = new Date().toISOString().split('T')[0];
  for (const regex of dateRegexes) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      date = match[1];
      break;
    }
  }

  // 3. IMPORTE TOTAL
  const totalRegexes = [
    /(?:total\s*factura|total\s*a\s*pagar|importe\s*total|liquido\s*a\s*pagar|total\s*eur|total\s*€|total\s*doc|total\s*general)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i,
    /(?:total|importe)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i
  ];

  let amount = 0;
  for (const regex of totalRegexes) {
    const match = cleanText.match(regex);
    if (match && match[1]) {
      const val = parseEuropeanNumber(match[1]);
      if (val > 0) {
        amount = val;
        break;
      }
    }
  }

  // Si no se encuentra etiqueta "Total", se busca el valor numérico más alto del texto
  if (amount === 0) {
    const allNumbers = cleanText.match(/[\d]{1,6}[,\.]\d{2}/g);
    if (allNumbers && allNumbers.length > 0) {
      const parsedValues = allNumbers.map(n => parseEuropeanNumber(n)).filter(v => v > 0);
      if (parsedValues.length > 0) {
        amount = Math.max(...parsedValues);
      }
    }
  }

  // 4. BASE IMPONIBLE
  const baseRegex = /(?:base\s*imponible|subtotal|b\.i\.|base\s*imp\.|base)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i;
  const baseMatch = cleanText.match(baseRegex);
  let baseAmount = baseMatch ? parseEuropeanNumber(baseMatch[1]) : 0;

  // 5. CUOTA DE IVA
  const ivaRegex = /(?:cuota\s*iva|importe\s*iva|iva\s*\d{1,2}%|iva)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i;
  const ivaMatch = cleanText.match(ivaRegex);
  let ivaAmount = ivaMatch ? parseEuropeanNumber(ivaMatch[1]) : 0;

  // LÓGICA DE CONTROL Y CORRECCIÓN MATEMÁTICA
  if (baseAmount === 0 && amount > 0) {
    if (ivaAmount > 0) {
      baseAmount = amount - ivaAmount;
    } else {
      baseAmount = amount / 1.21;
      ivaAmount = amount - baseAmount;
    }
  } else if (ivaAmount === 0 && amount > 0 && baseAmount > 0) {
    ivaAmount = amount - baseAmount;
  }

  // Corrección si la Base es mayor que el Total (ej. Total mal capturado)
  if (baseAmount > amount && amount > 0) {
    if (ivaAmount > 0) {
      amount = baseAmount + ivaAmount;
    } else {
      baseAmount = amount / 1.21;
      ivaAmount = amount - baseAmount;
    }
  }

  // Asegura que el IVA nunca sea negativo
  if (ivaAmount < 0) {
    ivaAmount = Math.abs(ivaAmount);
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

app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  
  if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else {
    res.send("Error: No se encuentra index.html.");
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 ¡Servidor InvoiceShift activo en puerto ${PORT}!`);
});