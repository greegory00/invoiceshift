const express = require('express');
const pdfParseModule = require('pdf-parse');
const path = require('path');

const pdfParse = typeof pdfParseModule === 'function' ? pdfParseModule : (pdfParseModule.default || pdfParseModule);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Convierte un string numérico (formato europeo o americano, ambiguo o no)
 * a un Number. Corrige el bug original: cuando solo hay un separador,
 * decide si es decimal o de miles según cuántos dígitos hay después.
 */
function parseEuropeanNumber(str) {
  if (!str) return 0;
  let clean = String(str).replace(/[^\d.,]/g, '').trim();
  if (!clean) return 0;

  const hasDot = clean.includes('.');
  const hasComma = clean.includes(',');

  if (hasDot && hasComma) {
    // Los dos aparecen: el que esté más a la derecha es el separador decimal.
    const lastDot = clean.lastIndexOf('.');
    const lastComma = clean.lastIndexOf(',');
    if (lastComma > lastDot) {
      clean = clean.replace(/\./g, '').replace(',', '.');
    } else {
      clean = clean.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = clean.split(',');
    if (parts.length > 2) {
      // Varias comas -> son separadores de miles (ej. "1,234,567")
      clean = clean.replace(/,/g, '');
    } else {
      const decimals = parts[1] ? parts[1].length : 0;
      // "1,234" con exactamente 3 dígitos suele ser miles, no decimales
      clean = decimals === 3 ? clean.replace(',', '') : clean.replace(',', '.');
    }
  } else if (hasDot) {
    const parts = clean.split('.');
    if (parts.length > 2) {
      // Varios puntos -> separadores de miles (ej. "1.234.567")
      clean = clean.replace(/\./g, '');
    } else {
      const decimals = parts[1] ? parts[1].length : 0;
      // "1.234" con exactamente 3 dígitos -> probablemente miles, no decimales
      if (decimals === 3) clean = clean.replace('.', '');
      // si tiene 1-2 decimales (ej "1234.56") se deja tal cual
    }
  }

  const value = parseFloat(clean);
  return isNaN(value) ? 0 : value;
}

// Extrae todos los números con pinta de importe (con decimales) de una línea,
// en el orden en que aparecen. En recibos/tickets el importe suele ser el
// último número de la línea (cantidad/precio unitario van antes).
function extractMoneyTokens(line) {
  const matches = line.match(/-?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})|-?\d+[.,]\d{1,2}/g);
  return matches || [];
}

// Busca la primera línea que cumpla el regex y devuelve el ÚLTIMO importe
// de esa línea (evita romperse si hay palabras como "EUROS" entre la
// etiqueta y el número, algo muy habitual en tickets de caja).
function findAmountByLineLabel(lines, labelRegex) {
  for (const line of lines) {
    if (labelRegex.test(line)) {
      const tokens = extractMoneyTokens(line);
      if (tokens.length > 0) {
        return parseEuropeanNumber(tokens[tokens.length - 1]);
      }
    }
  }
  return null;
}

// Detecta una tabla de desglose de IVA del tipo:
//   "4,00% 99,04 3,96"   o   "(B) 10,00% 1,47 0,15"
// Es el formato estándar en tickets y facturas simplificadas españolas,
// con o sin la palabra "IVA" en el encabezado, y con varios tipos (4/10/21%).
function extractVatTable(lines) {
  const vatLineRegex = /^\(?[A-Za-z]{0,2}\)?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s+([\d.,]+)\s+([\d.,]+)\s*€?$/;
  const rows = [];
  for (const line of lines) {
    const m = line.match(vatLineRegex);
    if (m) {
      const rate = parseEuropeanNumber(m[1]);
      const base = parseEuropeanNumber(m[2]);
      const cuota = parseEuropeanNumber(m[3]);
      // Sanity check: la cuota debe ser aproximadamente base * tipo/100
      // (con margen de redondeo). Si no cuadra, probablemente no era
      // realmente una fila de IVA sino una coincidencia casual.
      const expectedCuota = base * (rate / 100);
      if (Math.abs(expectedCuota - cuota) < Math.max(0.05, base * 0.02)) {
        rows.push({ rate, base, cuota });
      }
    }
  }
  return rows;
}

function parseInvoiceText(text) {
  const cleanText = text.replace(/\r/g, ' ');
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const warnings = [];

  // 1. NÚMERO DE DOCUMENTO
  // Se prueban patrones de más a menos específicos. Incluye formatos de
  // factura simplificada ("N.FACT.S:") y el NRF (identificador obligatorio
  // en tickets españoles desde la normativa Verifactu).
  const invoiceNumRegexes = [
    /n\.?\s*fact\.?\s*s?\.?\s*[:\.]\s*([A-Z0-9\-\/]{5,30})/i,
    /nrf\s*[:\.]?\s*([A-Z0-9]{5,30})/i,
    /(?:num(?:ero)?\s*factura|nº\s*factura|factura\s*nº|factura\s*num|factura\s*n°|nº\s*doc|nº\s*de\s*factura|nº\s*ref|fra\.\s*nº)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{2,25})/i,
    /(?:ticket\s*nº|nº\s*ticket|recibo\s*nº)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{2,25})/i,
    /(?:factura|invoice|nº|numero)\s*[:\.\-]?\s*([A-Z0-9\/\-_]{3,20})/i
  ];

  let invoiceNumber = 'S/N';
  for (const regex of invoiceNumRegexes) {
    const match = cleanText.match(regex);
    if (match && match[1] && match[1].trim().length > 1) {
      const candidate = match[1].trim();
      const forbidden = ['TOTAL', 'FECHA', 'IMPORTE', 'CLIENTE', 'PAGINA', 'FACTURA', 'BASE', 'SIMPLIFICADA', 'RECTIFICATIVA'];
      // Un número de factura casi siempre contiene al menos un dígito;
      // esto evita capturar palabras como "Simplificada".
      if (/\d/.test(candidate) && !forbidden.includes(candidate.toUpperCase())) {
        invoiceNumber = candidate;
        break;
      }
    }
  }
  if (invoiceNumber === 'S/N') {
    warnings.push('No se encontró número de factura/ticket de forma fiable.');
  }

  // 2. FECHA
  const dateRegex = /(?:fecha\s*(?:de\s*)?(?:emisi[oó]n|factura)?|date|f\.\s*factura)\s*[:\.\-]?\s*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/i;
  const dateMatch = cleanText.match(dateRegex) || cleanText.match(/(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
  if (!dateMatch) {
    warnings.push('No se encontró fecha en el documento; se usó la fecha actual como marcador.');
  } else if (!cleanText.match(dateRegex)) {
    warnings.push('La fecha se dedujo de la primera fecha encontrada en el texto (podría no ser la fecha de emisión).');
  }

  // 3. IMPORTE TOTAL — búsqueda línea a línea, por prioridad de etiqueta.
  // Se toma el ÚLTIMO importe de la línea encontrada, para no romperse si
  // hay texto (p.ej. "EUROS") entre la etiqueta y el número.
  let amount = null;
  const totalLabelPatterns = [
    /total\s*a\s*pagar/i,
    /total\s*a\s*abonar/i,
    /total\s*factura/i,
    /importe\s*total/i,
    /l[ií]quido\s*a\s*pagar/i
  ];
  for (const pattern of totalLabelPatterns) {
    amount = findAmountByLineLabel(lines, pattern);
    if (amount !== null) break;
  }
  if (amount === null) {
    // Último recurso: cualquier línea que empiece por "total" pero no "subtotal".
    amount = findAmountByLineLabel(lines, /^total\b(?!.*subtotal)/i);
    if (amount !== null) {
      warnings.push('El importe total se dedujo de una etiqueta genérica de "Total". Revísalo.');
    }
  }
  if (amount === null) {
    warnings.push('No se pudo detectar el importe total.');
    amount = 0;
  }

  // 4 y 5. BASE IMPONIBLE Y CUOTA DE IVA
  // Prioridad 1: tabla de desglose de IVA (soporta varios tipos: 4%, 10%, 21%...)
  const vatRows = extractVatTable(lines);
  let baseAmount = 0;
  let ivaAmount = 0;

  if (vatRows.length > 0) {
    baseAmount = vatRows.reduce((sum, r) => sum + r.base, 0);
    ivaAmount = vatRows.reduce((sum, r) => sum + r.cuota, 0);
    if (vatRows.length > 1) {
      warnings.push(`Se detectó un desglose de IVA con ${vatRows.length} tipos distintos (${vatRows.map(r => r.rate + '%').join(', ')}) y se sumaron.`);
    }
    // Cruce de validación contra el total, si lo tenemos.
    if (amount > 0 && Math.abs((baseAmount + ivaAmount) - amount) > 0.05) {
      warnings.push('La suma de la tabla de IVA no coincide exactamente con el total detectado; revisar.');
    }
  } else {
    // Prioridad 2: etiquetas explícitas de base/IVA en una línea.
    let base = findAmountByLineLabel(lines, /base\s*imponible/i);
    if (base === null) base = findAmountByLineLabel(lines, /b\.?\s*i\.?\s*[:\.]/i);
    let iva = findAmountByLineLabel(lines, /cuota\s*iva/i);
    if (iva === null) iva = findAmountByLineLabel(lines, /importe\s*iva/i);
    // También intentamos "IVA 21%: 45,00" en una sola línea.
    if (iva === null) {
      const inlineIvaMatch = cleanText.match(/(?:iva|i\.v\.a\.?)\s*\d{1,2}(?:[.,]\d+)?\s*%[^\d\-]{0,20}?([\d.,]{1,12})/i);
      if (inlineIvaMatch) iva = parseEuropeanNumber(inlineIvaMatch[1]);
    }

    if (base !== null) baseAmount = base;
    if (iva !== null) ivaAmount = iva;

    if (base === null && amount > 0) {
      if (iva !== null) {
        baseAmount = amount - ivaAmount;
        warnings.push('La base imponible se calculó como Total - IVA (no se encontró explícitamente).');
      } else {
        // Última opción: asumir 21%. Es una estimación y puede ser
        // incorrecta si el tipo real es reducido, superreducido o exento.
        baseAmount = amount / 1.21;
        ivaAmount = amount - baseAmount;
        warnings.push('No se encontró el IVA; se estimó asumiendo un 21% (revisar si el tipo real es distinto).');
      }
    } else if (iva === null && amount > 0 && baseAmount > 0) {
      ivaAmount = amount - baseAmount;
      warnings.push('La cuota de IVA se calculó como Total - Base (no se encontró explícitamente).');
    }
  }

  return {
    invoiceNumber,
    date,
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    ivaAmount: parseFloat(ivaAmount.toFixed(2)),
    amount: parseFloat(amount.toFixed(2)),
    warnings
  };
}

async function processPdfBuffer(buffer) {
  return await pdfParse(buffer);
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
        error: 'El PDF es un escáner/imagen sin texto interno (necesitaría OCR, no soportado actualmente).'
      });
    }

    const extractedData = parseInvoiceText(pdfData.text);

    console.log(`📄 ${fileName} | Base: ${extractedData.baseAmount}€ | IVA: ${extractedData.ivaAmount}€ | Total: ${extractedData.amount}€ | Avisos: ${extractedData.warnings.length}`);

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
