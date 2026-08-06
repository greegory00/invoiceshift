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
  // Limpia el texto dejando solo dígitos, comas y puntos
  let clean = str.replace(/[^\d\.,]/g, '').trim();
  if (clean.includes('.') && clean.includes(',')) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else if (clean.includes(',')) {
    clean = clean.replace(',', '.');
  }
  return parseFloat(clean) || 0;
}

function parseInvoiceText(rawText, fileName) {
  // Imprimir texto extraído en los Logs de Render para diagnóstico
  console.log(`\n=================== INICIO PDF: ${fileName} ===================`);
  console.log(rawText);
  console.log(`=================== FIN PDF: ${fileName} ===================\n`);

  // Dividir el documento en líneas independientes
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

  let invoiceNumber = 'S/N';
  let date = new Date().toISOString().split('T')[0];
  let amount = 0;
  let baseAmount = 0;
  let ivaAmount = 0;

  // 1. BÚSQUEDA DE TOTAL POR LÍNEAS
  const totalKeywords = ['total factura', 'total a pagar', 'importe total', 'liquido a pagar', 'total eur', 'total €', 'total general', 'total doc', 'total'];
  
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();

    // Comprobar si la línea contiene alguna palabra clave de Total
    const hasTotalKeyword = totalKeywords.some(kw => lineLower.includes(kw));

    if (hasTotalKeyword) {
      // Extraer números de la misma línea
      const numbersInLine = lines[i].match(/(?:€|\b)\s*([\d]{1,6}[,\.]\d{2})\s*(?:€|\b)/g);
      if (numbersInLine && numbersInLine.length > 0) {
        // Tomar el último número de la línea (habitualmente el importe)
        const lastNum = parseEuropeanNumber(numbersInLine[numbersInLine.length - 1]);
        if (lastNum > 0 && lastNum < 100000) {
          amount = lastNum;
          break;
        }
      } else if (i + 1 < lines.length) {
        // Si el importe está en la línea siguiente
        const numbersInNextLine = lines[i + 1].match(/(?:€|\b)\s*([\d]{1,6}[,\.]\d{2})\s*(?:€|\b)/g);
        if (numbersInNextLine && numbersInNextLine.length > 0) {
          const nextNum = parseEuropeanNumber(numbersInNextLine[0]);
          if (nextNum > 0 && nextNum < 100000) {
            amount = nextNum;
            break;
          }
        }
      }
    }
  }

  // 2. BÚSQUEDA DE BASE IMPONIBLE POR LÍNEAS
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (lineLower.includes('base imponible') || lineLower.includes('subtotal') || lineLower.includes('b.i.')) {
      const numbers = lines[i].match(/(?:€|\b)\s*([\d]{1,6}[,\.]\d{2})\s*(?:€|\b)/g);
      if (numbers && numbers.length > 0) {
        baseAmount = parseEuropeanNumber(numbers[numbers.length - 1]);
        break;
      }
    }
  }

  // 3. BÚSQUEDA DE NÚMERO DE FACTURA
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    if (lineLower.includes('factura') || lineLower.includes('nº') || lineLower.includes('num')) {
      const match = lines[i].match(/(?:nº|factura|num|doc|ref)[\s\:\.\-]*([A-Z0-9\/\-_]{3,25})/i);
      if (match && match[1] && /\d/.test(match[1])) {
        const candidate = match[1].trim();
        if (!/^\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}$/.test(candidate)) {
          invoiceNumber = candidate;
          break;
        }
      }
    }
  }

  // 4. BÚSQUEDA DE FECHA
  for (let i = 0; i < lines.length; i++) {
    const dateMatch = lines[i].match(/(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{4})/);
    if (dateMatch && dateMatch[1]) {
      date = dateMatch[1];
      break;
    }
  }

  // RECONSTRUCCIÓN Y COHERENCIA MATEMÁTICA
  if (amount === 0) {
    // Si no se encontró por línea, tomar el valor más alto con formato decimal del documento
    const allNumbers = rawText.match(/(?:€|\b)\s*([\d]{1,6}[,\.]\d{2})\s*(?:€|\b)/g);
    if (allNumbers && allNumbers.length > 0) {
      const validNumbers = allNumbers.map(n => parseEuropeanNumber(n)).filter(v => v > 0 && v < 50000);
      if (validNumbers.length > 0) {
        amount = Math.max(...validNumbers);
      }
    }
  }

  if (baseAmount === 0 && amount > 0) {
    baseAmount = amount / 1.21;
    ivaAmount = amount - baseAmount;
  } else if (baseAmount > 0 && amount > 0) {
    ivaAmount = amount - baseAmount;
  }

  return {
    invoiceNumber,
    date,
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    ivaAmount: parseFloat(Math.abs(ivaAmount).toFixed(2)),
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

    const extractedData = parseInvoiceText(pdfData.text, fileName || 'factura.pdf');

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
