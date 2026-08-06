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

// EXTRACTOR LOCAL DE RESPALDO (Orientado a palabras clave, evita IBANs)
function parseInvoiceLocal(rawText) {
  const cleanText = rawText.replace(/\r/g, ' ');
  const lines = cleanText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

  let invoiceNumber = 'S/N';
  let date = new Date().toISOString().split('T')[0];
  let amount = 0;
  let baseAmount = 0;
  let ivaAmount = 0;

  // 1. FECHA
  const dateRegexes = [
    /(?:fecha|date|f\.\s*factura|emisión)\s*[:\.\-]?\s*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/i,
    /(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/,
    /(\d{4}[\/\.-]\d{1,2}[\/\.-]\d{1,2})/
  ];
  for (const reg of dateRegexes) {
    const m = cleanText.match(reg);
    if (m && m[1]) {
      date = m[1];
      break;
    }
  }

  // 2. NÚMERO DE DOCUMENTO
  const docRegexes = [
    /(?:nº\s*factura|factura\s*nº|nº\s*doc|nº\s*fra|num\.\s*factura|factura\s*num|nº\s*ticket|ref\.?)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{3,30})/i,
    /(?:factura|invoice)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{4,25})/i
  ];
  for (const reg of docRegexes) {
    const m = cleanText.match(reg);
    if (m && m[1]) {
      const cand = m[1].trim();
      const isDate = /^\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}$/.test(cand);
      const isForbidden = /TOTAL|FECHA|IMPORTE|DOCUMENTO|CLIENTE|PAGINA/i.test(cand);
      if (!isDate && !isForbidden && /\d/.test(cand)) {
        invoiceNumber = cand;
        break;
      }
    }
  }

  // 3. EXTRAER TOTAL BUSCANDO LA PALABRA "TOTAL" (No el número más alto)
  const totalKeywords = ['total factura', 'total a pagar', 'importe total', 'liquido a pagar', 'total eur', 'total €', 'total general', 'total doc'];
  
  for (const line of lines) {
    const lLower = line.toLowerCase();
    for (const kw of totalKeywords) {
      if (lLower.includes(kw)) {
        const numMatch = line.match(/([\d]{1,5}[,\.]\d{2})/g);
        if (numMatch && numMatch.length > 0) {
          const val = parseEuropeanNumber(numMatch[numMatch.length - 1]);
          if (val > 0) {
            amount = val;
            break;
          }
        }
      }
    }
    if (amount > 0) break;
  }

  // Búsqueda secundaria si no estaba en la misma línea
  if (amount === 0) {
    for (let i = 0; i < lines.length; i++) {
      const lLower = lines[i].toLowerCase();
      if (lLower === 'total' || lLower.startsWith('total ') || lLower.endsWith(' total')) {
        const searchBlock = lines[i] + ' ' + (lines[i+1] || '');
        const numMatch = searchBlock.match(/([\d]{1,5}[,\.]\d{2})/g);
        if (numMatch && numMatch.length > 0) {
          const val = parseEuropeanNumber(numMatch[numMatch.length - 1]);
          if (val > 0) {
            amount = val;
            break;
          }
        }
      }
    }
  }

  // 4. BASE IMPONIBLE E IVA
  const baseMatch = cleanText.match(/(?:base\s*imponible|subtotal|b\.i\.)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i);
  if (baseMatch && baseMatch[1]) {
    baseAmount = parseEuropeanNumber(baseMatch[1]);
  }

  const ivaMatch = cleanText.match(/(?:cuota\s*iva|importe\s*iva|iva)\s*[:\.]?\s*[$€£]?\s*([\d\.,]{1,12})/i);
  if (ivaMatch && ivaMatch[1]) {
    const candidateIva = parseEuropeanNumber(ivaMatch[1]);
    if (candidateIva < amount) {
      ivaAmount = candidateIva;
    }
  }

  // COHERENCIA MATEMÁTICA
  if (amount > 0 && baseAmount === 0) {
    if (ivaAmount > 0) {
      baseAmount = amount - ivaAmount;
    } else {
      baseAmount = amount / 1.21;
      ivaAmount = amount - baseAmount;
    }
  } else if (baseAmount > 0 && amount === 0) {
    ivaAmount = baseAmount * 0.21;
    amount = baseAmount + ivaAmount;
  }

  return {
    invoiceNumber,
    date,
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    ivaAmount: parseFloat(Math.abs(ivaAmount).toFixed(2)),
    amount: parseFloat(amount.toFixed(2))
  };
}

// IA CON MODELOS EN CASCADA
async function extractInvoiceWithAI(pdfText) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Sin API Key configurada.");
  }

  const prompt = `Analiza la siguiente factura y extrae ÚNICAMENTE los datos en JSON puro.

Texto:
"""
${pdfText}
"""

Responde EXCLUSIVAMENTE en formato JSON:
{
  "invoiceNumber": "Número o serie de factura. Si no existe, 'S/N'",
  "date": "Fecha DD/MM/YYYY",
  "baseAmount": 0.00,
  "ivaAmount": 0.00,
  "amount": 0.00
}

Reglas:
1. amount es el IMPORTE TOTAL FINAL A PAGAR. No confundas el 21% de IVA con el importe total.
2. baseAmount + ivaAmount debe ser igual a amount.
3. Si la factura no desglosa el IVA, calcula baseAmount = amount / 1.21 e ivaAmount = amount - baseAmount.`;

  // Lista de modelos a intentar en orden de preferencia
  const modelsToTry = [
    'gemini-1.5-flash',
    'gemini-2.0-flash-exp',
    'gemini-1.5-pro'
  ];

  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const apiData = await response.json();

      if (response.ok && apiData.candidates?.[0]?.content?.parts?.[0]?.text) {
        const rawText = apiData.candidates[0].content.parts[0].text;
        const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanJson);

        return {
          invoiceNumber: parsed.invoiceNumber || 'S/N',
          date: parsed.date || new Date().toISOString().split('T')[0],
          baseAmount: parseFloat((parsed.baseAmount || 0).toFixed(2)),
          ivaAmount: parseFloat((parsed.ivaAmount || 0).toFixed(2)),
          amount: parseFloat((parsed.amount || 0).toFixed(2))
        };
      } else {
        lastError = apiData.error?.message || `Error en modelo ${modelName}`;
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  throw new Error(`Los modelos de IA no respondieron: ${lastError}`);
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
      return res.status(400).json({ error: 'No se recibió archivo.' });
    }

    const base64Data = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;
    const buffer = Buffer.from(base64Data, 'base64');
    const pdfData = await processPdfBuffer(buffer);

    if (!pdfData || !pdfData.text || pdfData.text.trim().length === 0) {
      return res.status(400).json({ error: 'El PDF es un escáner/imagen sin texto interno.' });
    }

    let extractedData;
    try {
      extractedData = await extractInvoiceWithAI(pdfData.text);
    } catch (aiError) {
      console.warn(`⚠️ Error de IA en ${fileName}: ${aiError.message}. Usando motor local de respaldo.`);
      extractedData = parseInvoiceLocal(pdfData.text);
    }

    return res.json({
      success: true,
      fileName: fileName || 'factura.pdf',
      data: extractedData
    });

  } catch (error) {
    console.error('❌ ERROR GENERAL:', error.message);
    return res.status(500).json({ error: `Error al procesar: ${error.message}` });
  }
});

app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicPath)) res.sendFile(publicPath);
  else if (fs.existsSync(rootPath)) res.sendFile(rootPath);
  else res.send("Error: No se encuentra index.html.");
});

app.listen(PORT, () => {
  console.log(`\n🚀 ¡Servidor InvoiceShift activo en puerto ${PORT}!`);
});
