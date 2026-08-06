const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Análisis visual enviando el PDF completo a la API de IA
async function extractInvoiceWithVisionAI(base64Data) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("No se ha configurado la variable GEMINI_API_KEY en Render.");
  }

  const prompt = `Analiza visualmente este documento de factura y extrae con máxima precisión los siguientes datos en formato JSON puro.

Campos requeridos:
- invoiceNumber: Número, serie o identificador principal de la factura. Si no existe, pon 'S/N'.
- date: Fecha de emisión de la factura en formato DD/MM/YYYY.
- baseAmount: Suma total de las bases imponibles (número decimal).
- ivaAmount: Suma total de la cuota de IVA/impuestos (número decimal).
- amount: IMPORTE TOTAL A PAGAR de la factura (número decimal).

Reglas estrictas:
1. "amount" DEBE ser la cifra final a pagar. No la confundas con porcentajes (ej. 21%), IBANs, códigos de barras o subtotales.
2. Si la factura no muestra explícitamente el desglose de IVA pero incluye IVA, calcula: baseAmount = amount / 1.21 e ivaAmount = amount - baseAmount.
3. Devuelve únicamente el JSON con los números redondeados a 2 decimales.`;

  const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: cleanBase64
            }
          },
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const apiData = await response.json();

  if (!response.ok) {
    throw new Error(apiData.error?.message || 'Error al procesar el PDF con la API.');
  }

  const rawJson = apiData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  const parsed = JSON.parse(rawJson);

  return {
    invoiceNumber: parsed.invoiceNumber || 'S/N',
    date: parsed.date || new Date().toISOString().split('T')[0],
    baseAmount: parseFloat((parsed.baseAmount || 0).toFixed(2)),
    ivaAmount: parseFloat((parsed.ivaAmount || 0).toFixed(2)),
    amount: parseFloat((parsed.amount || 0).toFixed(2))
  };
}

app.post('/api/parse-pdf', async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body;

    if (!fileBase64) {
      return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    }

    // Extracción visual mediante IA multimodal
    const extractedData = await extractInvoiceWithVisionAI(fileBase64);

    return res.json({
      success: true,
      fileName: fileName || 'factura.pdf',
      data: extractedData
    });

  } catch (error) {
    console.error(`❌ ERROR PROCESANDO ${req.body.fileName || 'archivo'}:`, error.message);
    return res.status(500).json({ 
      error: `Error al procesar: ${error.message}` 
    });
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
  console.log(`\n🚀 ¡Servidor InvoiceShift (Procesamiento Multimodal Nativo) activo en puerto ${PORT}!`);
});
