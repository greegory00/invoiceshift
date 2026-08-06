const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Función para reintentar peticiones con pausa cuando la API reporta saturación (HTTP 429)
async function fetchWithRetry(url, options, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url, options);
    
    // Si no hay problema de límite de tasa, devolvemos la respuesta directamente
    if (response.status !== 429) {
      return response;
    }

    console.warn(`⚠️ Límite de la API alcanzado. Esperando ${delayMs / 1000}s para reintentar (Intento ${i + 1} de ${retries})...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    delayMs *= 1.5; // Incrementa el tiempo de espera en cada reintento
  }
  return await fetch(url, options);
}

async function extractInvoiceWithAI(base64Data) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("No se ha configurado la variable GEMINI_API_KEY en Render.");
  }

  const cleanBase64 = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;

  const prompt = `Analiza visualmente esta factura PDF y extrae los datos en formato JSON puro.

Estructura requerida:
{
  "invoiceNumber": "Número o serie de la factura. Si no existe, 'S/N'",
  "date": "Fecha de emisión en formato DD/MM/YYYY",
  "baseAmount": 0.00,
  "ivaAmount": 0.00,
  "amount": 0.00
}

Reglas estrictas:
1. "amount" DEBE ser el importe TOTAL A PAGAR.
2. baseAmount + ivaAmount = amount.
3. Responde únicamente con el objeto JSON puro.`;

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const payload = {
        contents: [
          {
            parts: [
              { inlineData: { mimeType: "application/pdf", data: cleanBase64 } },
              { text: prompt }
            ]
          }
        ],
        generationConfig: { responseMimeType: "application/json" }
      };

      const response = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const apiData = await response.json();

      if (response.ok && apiData.candidates?.[0]?.content?.parts?.[0]?.text) {
        const rawJson = apiData.candidates[0].content.parts[0].text;
        const parsed = JSON.parse(rawJson);

        return {
          invoiceNumber: parsed.invoiceNumber || 'S/N',
          date: parsed.date || new Date().toISOString().split('T')[0],
          baseAmount: parseFloat((parsed.baseAmount || 0).toFixed(2)),
          ivaAmount: parseFloat((parsed.ivaAmount || 0).toFixed(2)),
          amount: parseFloat((parsed.amount || 0).toFixed(2))
        };
      } else {
        lastError = apiData.error?.message || `Error en el modelo ${model}`;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  throw new Error(`Saturación de API: ${lastError}`);
}

app.post('/api/parse-pdf', async (req, res) => {
  try {
    const { fileBase64, fileName } = req.body;

    if (!fileBase64) {
      return res.status(400).json({ error: 'No se recibió archivo.' });
    }

    const extractedData = await extractInvoiceWithAI(fileBase64);

    return res.json({
      success: true,
      fileName: fileName || 'factura.pdf',
      data: extractedData
    });

  } catch (error) {
    console.error(`❌ ERROR EN ${req.body.fileName || 'archivo'}:`, error.message);
    return res.status(500).json({ error: error.message });
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
  console.log(`\n🚀 ¡Servidor InvoiceShift (Con Reintentos de Cuota) activo en puerto ${PORT}!`);
});
