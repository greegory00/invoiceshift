const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para parsear JSON y servir archivos estáticos
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Parser de texto de facturas mediante RegEx de alto rendimiento
 * @param {string} text - Texto extraído de la factura
 * @returns {Object} Datos estructurados de la factura
 */
function parseInvoiceText(text) {
  // Patrones de búsqueda comunes para facturas
  const totalRegex = /(?:total|importe\s*total|amount\s*due|suma)\s*:?\s*[$€£]?\s*(\d+[\.,]\d{2})/i;
  const dateRegex = /(?:fecha|date)\s*:?\s*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/i;
  const invoiceNumRegex = /(?:factura|invoice|nº|num)\s*:?\s*([A-Z0-9\-_]+)/i;

  const totalMatch = text.match(totalRegex);
  const dateMatch = text.match(dateRegex);
  const numMatch = text.match(invoiceNumRegex);

  return {
    invoiceNumber: numMatch ? numMatch[1] : 'N/A',
    date: dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0],
    amount: totalMatch ? parseFloat(totalMatch[1].replace(',', '.')) : 0.00,
    rawLength: text.length,
    processedAt: new Date().toISOString()
  };
}

// Endpoint principal del parser
app.post('/api/parse', (req, res) => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'El contenido del documento es obligatorio.' });
    }

    const parsedData = parseInvoiceText(content);
    return res.json({ success: true, data: parsedData });
  } catch (error) {
    return res.status(500).json({ error: 'Error procesando el documento.' });
  }
});

app.listen(PORT, () => {
  console.log(`[InvoiceShift MVP] Servidor ejecutándose en http://localhost:${PORT}`);
});
