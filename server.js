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

// Extracción local de respaldo si la API de IA agota su cuota
function parseInvoiceLocal(text) {
  const cleanText = text.replace(/\r/g, ' ');
  const lines = cleanText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);

  let invoiceNumber = 'S/N';
  let date = new Date().toISOString().split('T')[0];
  let amount = 0;
  let baseAmount = 0;
  let ivaAmount = 0;

  // Fecha
  const dateMatch = cleanText.match(/(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/);
  if (dateMatch) date = dateMatch[1];

  // Nº Documento
  const docMatch = cleanText.match(/(?:nº|factura|num|doc|ref)[\s\:\.\-]*([A-Z0-9\/\-_]{3,25})/i);
  if (docMatch && docMatch[1] && /\d/.test(docMatch[1])) {
    invoiceNumber = docMatch[1].trim();
  }

  // Importe Total
  const candidates = cleanText.match(/(?:€|\b)\s*([\d]{1,6}[,\.]\d{2})\s*(?:€|\b)/g);
  if (candidates && candidates.length > 0) {
    const validNumbers = candidates.map(n => parseEuropeanNumber(n)).filter(v => v > 0 && v < 50000);
    if (validNumbers.length > 0) {
      amount = Math.max(...validNumbers);
    }
  }

  baseAmount = amount / 1.21;
  ivaAmount = amount - baseAmount;

  return {
    invoiceNumber,
    date,
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    ivaAmount: parseFloat(ivaAmount.toFixed(2)),
    amount: parseFloat(amount.toFixed(2))
  };
}

async function extractInvoiceWithAI(pdfText) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Sin API Key configurada.");
  }

  const prompt = `Analiza la siguiente factura y extrae en JSON puro:
{
  "invoiceNumber": "Número o serie. Si no existe, 'S/N'",
  "date": "Fecha DD/MM/YYYY",
  "baseAmount": 0.00,
  "ivaAmount": 0.00,
  "amount": 0.00
}

Texto:
"""
${pdfText}
"""`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  const apiData = await response.json();

  if (!response.ok) {
    throw new Error(apiData.error?.message || 'Límite de cuota o error de API.');
  }

  const rawText = apiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(cleanJson);

  return {
    invoiceNumber: parsed.invoiceNumber || 'S/N',
    date: parsed.date || new Date().toISOString().split('T')[0],
    baseAmount: parseFloat((parsed.baseAmount || 0).toFixed(2)),
    ivaAmount: parseFloat((parsed.ivaAmount || 0).toFixed(2)),
    amount: parseFloat((parsed.amount || 0).toFixed(2))
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
      return res.status(400).json({ error: 'No se recibió archivo.' });
    }

    const base64Data = fileBase64.includes(',') ? fileBase64.split(',')[1] : fileBase64;
    const buffer = Buffer.from(base64Data, 'base64');
    const pdfData = await processPdfBuffer(buffer);

    if (!pdfData || !pdfData.text || pdfData.text.trim().length === 0) {
      return res.status(400).json({ error: 'El PDF no contiene texto legible.' });
    }

    let extractedData;
    try {
      // Intentar procesar con IA
      extractedData = await extractInvoiceWithAI(pdfData.text);
    } catch (aiError) {
      console.warn(`⚠️ Cuota de IA excedida o error en API para ${fileName}. Usando motor de respaldo local.`);
      // Si la IA falla o supera la cuota, conmuta al motor local
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
