const express = require('express');
const pdfParseModule = require('pdf-parse');
const path = require('path');
const fs = require('fs');

const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : (pdfParseModule.default || pdfParseModule);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function extractInvoiceWithAI(pdfText) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("No se ha configurado la variable GEMINI_API_KEY en Render.");
  }

  const prompt = `Analiza el texto de la siguiente factura y extrae únicamente los datos requeridos en formato JSON puro.

Texto de la factura:
"""
${pdfText}
"""

Responde EXCLUSIVAMENTE con un objeto JSON válido sin texto adicional ni bloques markdown. La estructura debe ser exactamente esta:
{
  "invoiceNumber": "Número o serie de la factura. Si no existe o no es claro, usa 'S/N'",
  "date": "Fecha de emisión en formato DD/MM/YYYY. Si no existe, usa la fecha actual",
  "baseAmount": 0.00,
  "ivaAmount": 0.00,
  "amount": 0.00
}

Reglas estrictas:
1. baseAmount, ivaAmount y amount deben ser números decimales (ejemplo: 45.50).
2. "amount" es el IMPORTE TOTAL A PAGAR de la factura. No confundas el porcentaje de impuesto (ej. 21%) con el importe total.
3. Asegúrate de que baseAmount + ivaAmount sea igual a amount. Si la factura no desglosa el IVA, calcula baseAmount = amount / 1.21 e ivaAmount = amount - baseAmount.`;

  // URL actualizada al modelo activo gemini-2.0-flash
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });

  const apiData = await response.json();

  if (!response.ok) {
    throw new Error(apiData.error?.message || 'Error al comunicarse con la API de IA.');
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

    const extractedData = await extractInvoiceWithAI(pdfData.text);

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
  console.log(`\n🚀 ¡Servidor InvoiceShift (Motor IA Gemini 2.0) activo en puerto ${PORT}!`);
});
