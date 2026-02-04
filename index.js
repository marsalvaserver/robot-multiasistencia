const { chromium } = require('playwright');
const admin = require('firebase-admin');


if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();
const COLLECTION_PENDIENTES = "multiasistencia_pendientes";

async function runMultiasistencia() {
  console.log(`\n🕒 [${new Date().toLocaleTimeString()}] Iniciando ciclo...`);
  let user, pass;

  try {
    const credSnap = await db.collection("providerCredentials").doc("multiasistencia").get();
    if (!credSnap.exists) return console.error("❌ No hay credenciales.");
    user = credSnap.data().user;
    pass = credSnap.data().pass;
  } catch (e) {
    return console.error("❌ Error Firestore:", e.message);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    console.log("🌍 Entrando a la web...");
    await page.goto('https://web.multiasistencia.com/w3multi/acceso.php', { waitUntil: 'networkidle', timeout: 60000 });

    const userFilled = await page.evaluate((u) => {
      const el = document.querySelector('input[name="usuario"]') || document.querySelector('input[type="text"]');
      if (el) {
        el.value = u;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    }, user);

    if (!userFilled) await page.fill('input[name="usuario"]', user);
    await page.fill('input[type="password"]', pass);
    await page.click('input[type="submit"]');
    await page.waitForTimeout(4000);

    console.log("🔄 Cargando listado...");
    for (let i = 1; i <= 3; i++) {
      await page.goto('https://web.multiasistencia.com/w3multi/frepasos_new.php?refresh=1', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }

    let tieneSiguiente = true;
    let paginaActual = 1;

    while (tieneSiguiente && paginaActual <= 3) {
      console.log(`📄 Página ${paginaActual}...`);

      const expedientes = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="reparacion="]'));
        return Array.from(new Set(links.map(a => a.href.match(/reparacion=(\d+)/)?.[1]).filter(Boolean)));
      });

      if (expedientes.length === 0) {
        for (const frame of page.frames()) {
          const frameLinks = await frame.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="reparacion="]'));
            return Array.from(new Set(links.map(a => a.href.match(/reparacion=(\d+)/)?.[1]).filter(Boolean)));
          });
          if (frameLinks.length > 0) expedientes.push(...frameLinks);
        }
      }

      console.log(`🔍 Encontrados ${expedientes.length} expedientes.`);

      for (const ref of expedientes) {
        const detalleUrl = `https://web.multiasistencia.com/w3multi/repasos1.php?reparacion=${ref}`;

        try {
          await page.goto(detalleUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1500);

          let foundData = false;

          for (const frame of page.frames()) {
            try {
              const scrapData = await frame.evaluate(() => {
                const clean = (text) => text ? text.replace(/\s+/g, ' ').trim() : "";
                const bodyText = document.body?.innerText || "";

                if (!bodyText.includes("Nombre Cliente") && !bodyText.includes("Asegurado")) return null;

                // Buscar valor por fila: "Etiqueta" | "Valor"
                const findRowValue = (labels) => {
                  const rows = Array.from(document.querySelectorAll('tr'));
                  for (const tr of rows) {
                    const tds = Array.from(tr.querySelectorAll('td'));
                    if (tds.length >= 2) {
                      const key = clean(tds[0].innerText).toUpperCase();
                      if (labels.some(l => key === l.toUpperCase())) {
                        const val = clean(tds[1].innerText);
                        if (val) return val;
                      }
                    }
                  }
                  return "";
                };

                const allCells = Array.from(document.querySelectorAll('td, th'));

                const getVertical = (keywords) => {
                  const header = allCells.find(el => keywords.some(k => (el.innerText || "").trim().toUpperCase() === k.toUpperCase()));
                  if (!header) return null;
                  const cellIndex = header.cellIndex;
                  const row = header.parentElement;
                  const tbody = row.parentElement;
                  let nextRow = row.nextElementSibling;

                  if (!nextRow && tbody.tagName === 'THEAD') {
                    const table = header.closest('table');
                    const realBody = table ? table.querySelector('tbody') : null;
                    if (realBody && realBody.rows && realBody.rows[0]) nextRow = realBody.rows[0];
                  }

                  if (nextRow && nextRow.cells && nextRow.cells[cellIndex]) {
                    return clean(nextRow.cells[cellIndex].innerText);
                  }
                  return null;
                };

                const getHorizontal = (keywords) => {
                  const header = allCells.find(el => keywords.some(k => (el.innerText || "").toUpperCase().includes(k.toUpperCase())));
                  if (header && header.nextElementSibling) {
                    return clean(header.nextElementSibling.innerText);
                  }
                  return null;
                };

                // ✅ DESCRIPTION: "Descripción de la Reparación" y cortar antes de la primera fecha dd/mm/yyyy
                const getDescription = () => {
                  let text =
                    findRowValue(["Descripción de la Reparación"]) ||
                    getHorizontal(["Descripción de la Reparación", "Descripción", "Daños"]) ||
                    "";

                  text = clean(text);

                  // Cortar en la primera fecha dd/mm/yyyy (da igual si va con paréntesis o no)
                  const idxDate = text.search(/\b\d{2}\/\d{2}\/\d{4}\b/);
                  if (idxDate !== -1) {
                    text = text.substring(0, idxDate).trim();
                  }
                  return text;
                };

                // ✅ multiStatus: guardar el ESTADO tal cual aparece (incluyendo "(27/07/2025 - 13:13)")
                const getStatus = () => {
                  const st = findRowValue(["Estado", "Situación"]);
                  if (st) return st; // guardamos todo el texto
                  return getHorizontal(["Estado", "Situación"]) || "PENDIENTE";
                };

                const getDate = () => {
                  let dt = getHorizontal(["Fecha/Hora Apertura", "Fecha Apertura"]);
                  if (dt) dt = dt.replace('/', '').replace(/\s+/g, ' ').trim();
                  return dt || "";
                };

                const getPhone = () => {
                  let rawText = "";
                  const titleDiv = Array.from(document.querySelectorAll('div.subtitulo'))
                    .find(d => (d.innerText || "").includes("Teléfono del Cliente"));

                  if (titleDiv) {
                    const table = titleDiv.closest('table') || titleDiv.parentElement.querySelector('table');
                    if (table) rawText = table.innerText || "";
                  }
                  if (!rawText) rawText = bodyText;

                  const match = rawText.match(/[6789]\d{8}/);
                  return match ? match[0] : "Sin teléfono";
                };

                const getCompany = () => {
                  let text = getHorizontal(["Procedencia", "Compañía"]);
                  if (!text) {
                    const regex = /Procedencia\s*[:\-]?\s*([^\n]+)/i;
                    const match = bodyText.match(regex);
                    if (match) text = match[1];
                  }
                  if (!text) return "MULTI - MULTIASISTENCIA";
                  return `MULTI - ${clean(text)}`;
                };

                const rawAddress = getVertical(["Dirección", "Domicilio"]);
                const rawZip = getVertical(["Distrito Postal", "C.P", "Distrito"]);
                let fullAddress = rawAddress || "Sin dirección";
                if (rawZip) fullAddress = `${fullAddress} ${rawZip}`;

                return {
                  clientName: getVertical(["Nombre Cliente", "Asegurado"]),
                  address: fullAddress,
                  company: getCompany(),
                  phone: getPhone(),
                  description: getDescription(),
                  multiStatus: getStatus(),
                  dateString: getDate(),
                  serviceNumber: "",
                  hasContent: true
                };
              });

              if (scrapData && scrapData.clientName) {
                scrapData.serviceNumber = ref;
                console.log(`✅ EXITO ${ref}: ${scrapData.clientName} | Estado: ${scrapData.multiStatus}`);

                await db.collection(COLLECTION_PENDIENTES).doc(ref).set({
                  ...scrapData,
                  status: "pendiente_validacion",
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });

                foundData = true;
                break;
              }
            } catch (e) { /* ignore frame errors */ }
          }

          if (!foundData) {
            console.log(`⚠️ ALERTA: No se pudo leer ${ref}`);
            await db.collection(COLLECTION_PENDIENTES).doc(ref).set({
              serviceNumber: ref,
              status: "error_formato",
              clientName: "ERROR - REVISAR MANUAL",
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          }

        } catch (errDetail) {
          console.error(`❌ Error en ${ref}:`, errDetail.message);
        }
      }

      if (paginaActual >= 3) break;

      const siguientePaginaNum = paginaActual + 1;
      console.log(`➡️ Pasando a pág ${siguientePaginaNum}...`);
      await page.goto(
        `https://web.multiasistencia.com/w3multi/frepasos_new.php?refresh=1&paginasiguiente=${siguientePaginaNum}`,
        { waitUntil: 'domcontentloaded' }
      );

      const hayResultados = await page.evaluate(() => document.querySelectorAll('a[href*="reparacion="]').length > 0);
      if (hayResultados) {
        paginaActual++;
        await page.waitForTimeout(2000);
      } else {
        tieneSiguiente = false;
      }
    }

  } catch (e) {
    console.error("❌ Error General:", e.message);
  } finally {
    await browser.close();
  }
}

async function start() {
  while (true) {
    await runMultiasistencia();
    console.log("💤 Durmiendo 15 minutos...");
    await new Promise(r => setTimeout(r, 15 * 60 * 1000));
  }
}

start();
